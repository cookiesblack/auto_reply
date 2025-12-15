// autoReply.js
import nodemailer from 'nodemailer';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import dotenv from 'dotenv';
dotenv.config();

dayjs.extend(utc);
dayjs.extend(timezone);

// ----------------------------
// KONFIGURASI
// ----------------------------
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const IMAP_HOST = process.env.IMAP_HOST;
const IMAP_PORT = process.env.IMAP_PORT;
const HOUR_START = process.env.HOUR_START;
const HOUR_END = process.env.HOUR_END;
const DEBUG_TIME_CHECK = process.env.DEBUG_TIME_CHECK ?? 30;
const PROD_TIME_CHECK = process.env.PROD_TIME_CHECK ?? 60;


// IMAP
const IMAP_CONFIG = {
    imap: {
        user: EMAIL_USER,
        password: EMAIL_PASS,
        host: IMAP_HOST,
        port: IMAP_PORT,
        tls: true,
        authTimeout: 3000,
    },
    onError: console.error
};

// SMTP
const SMTP_CONFIG = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
    }
};

const DEBUG_MODE = process.env.DEBUG_MODE ?? true;

const TIMEZONE = 'Asia/Jakarta';

async function autoReply() {
    const now = dayjs().tz(TIMEZONE);
    const hour = now.hour();
    const isNightTime = hour >= HOUR_START || hour < HOUR_END;

    if (!DEBUG_MODE && !isNightTime) {
        console.log(`[${now.format('YYYY-MM-DD HH:mm:ss')}] Auto-reply inactive (working hours)`);
        return;
    }

    if (DEBUG_MODE) {
        console.log(`[${now.format('YYYY-MM-DD HH:mm:ss')}] [DEBUG] Auto-reply running`);
    }

    let connection;
    try {
        connection = await imaps.connect(IMAP_CONFIG);
        await connection.openBox('INBOX');

        const searchCriteria = ['UNSEEN', 'UNANSWERED'];
        const fetchOptions = {
            bodies: ['HEADER', 'TEXT'],
            markSeen: false,
            struct: true
        };

        const emails = await connection.search(searchCriteria, fetchOptions);

        if (!emails.length) {
            if (DEBUG_MODE) console.log('No new emails to process');
            connection.end();
            return;
        }

        console.log(`Found ${emails.length} new email(s) to process`);

        const transporter = nodemailer.createTransport(SMTP_CONFIG);

        for (const email of emails) {
            try {
                console.log('Email UID:', email.attributes.uid);

                const headerPart = email.parts.find(part => part.which === 'HEADER');
                if (!headerPart) continue;

                const headerObj = headerPart.body;
                let emailRaw = '';
                for (const [key, values] of Object.entries(headerObj)) {
                    if (Array.isArray(values)) {
                        values.forEach(value => emailRaw += `${key}: ${value}\r\n`);
                    } else {
                        emailRaw += `${key}: ${values}\r\n`;
                    }
                }
                emailRaw += '\r\n';

                const parsedEmail = await simpleParser(emailRaw);

                if (!parsedEmail.from?.value?.length) continue;

                const fromObj = parsedEmail.from.value[0];
                const fromEmail = fromObj.address.toLowerCase();
                const fromName = fromObj.name || '';
                const subject = parsedEmail.subject || '(No Subject)';

                const isFromSelf = fromEmail === EMAIL_USER.toLowerCase();

                const isFluentForm = isFromSelf;

                if (isFromSelf && subject.toLowerCase().startsWith('re:')) {
                    console.log('  → IGNORED: Our own auto-reply (loop prevention)');
                    await connection.addFlags(email.attributes.uid, ['\\Seen']);
                    continue;
                }

                if (fromEmail.includes('no-reply') ||
                    fromEmail.includes('noreply') ||
                    fromEmail.includes('mailer-daemon') ||
                    subject.toLowerCase().includes('auto')) {
                    console.log('  → IGNORED: Auto-mailer detected');
                    await connection.addFlags(email.attributes.uid, ['\\Seen']);
                    continue;
                }

                const ignoreDomains = ['@stripe.com', '@amazon.com.au'];
                if (ignoreDomains.some(domain => fromEmail.endsWith(domain))) {
                    console.log(`  → IGNORED: Domain in ignore list (${fromEmail})`);
                    await connection.addFlags(email.attributes.uid, ['\\Seen']);
                    continue;
                }

                const textPart = email.parts.find(part => part.which === 'TEXT');
                let emailBody = '';
                if (textPart && textPart.body) {
                    emailBody = textPart.body;
                }

                let targetEmail = '';
                let targetName = 'there';

                if (isFluentForm) {
                    // Cek Reply-To terlebih dahulu
                    if (parsedEmail.replyTo?.value?.length) {
                        const replyTo = parsedEmail.replyTo.value[0];
                        targetEmail = replyTo.address.toLowerCase();
                        targetName = replyTo.name || 'there';
                    }

                    // Jika tidak ada reply-to, extract dari body email
                    if (!targetEmail && emailBody) {
                        // Extract email dari body
                        // const emailMatch = emailBody.match(/Email[:\s]+([^\s\n<>]+@[^\s\n<>]+)/i);
                        // if (emailMatch) {
                        //     targetEmail = emailMatch[1].toLowerCase().trim();
                        // }

                        // // Extract nama dari body
                        // const namaMatch = emailBody.match(/Full Name[:\s]+([^\n\r]+)/i);
                        // if (namaMatch) {
                        //     targetName = namaMatch[1].trim();
                        // }

                        // console.log(emailBody);

                        const emailMatch = emailBody.match(/<th[^>]*>\s*<strong[^>]*>\s*Email\s*<\/strong>\s*<\/th>[\s\S]*?<td[^>]*>\s*([^\s<]+@[^\s<]+)\s*<\/td>/i);
                        if (emailMatch) {
                            targetEmail = emailMatch[1].trim();
                        }

                        const nameMatch = emailBody.match(/<th[^>]*>\s*<strong[^>]*>\s*Full Name\s*<\/strong>\s*<\/th>[\s\S]*?<td[^>]*>\s*([^<]+?)\s*<\/td>/i);
                        if (nameMatch) {
                            targetName = nameMatch[1].trim();
                        }

                        console.log(`target email: ${targetEmail}`);
                        console.log(`target name: ${targetName}`);

                    }



                    if (!targetEmail) {
                        console.log('  → IGNORED: Cannot extract customer email from Fluent Form');
                        await connection.addFlags(email.attributes.uid, ['\\Seen']);

                        // throw new Error("batal");

                        continue;
                    }

                    console.log(`  → Fluent Form - replying to: ${targetName} <${targetEmail}>`);
                } else {
                    targetEmail = fromEmail;
                    targetName = fromName || 'there';
                }

                const mailOptions = {
                    from: `"GasPro Detection" <${EMAIL_USER}>`,
                    to: `${targetName} <${targetEmail}>`,
                    subject: `Re: We'll Reply Soon As Possible`,
                    text: `Dear ${targetName},

Thank you for contacting GasPro Detection.

Your message has been received and is currently being reviewed by our team. One of our representatives will get back to you as soon as possible.

Kind regards,
GasPro Detection Team`,
                    inReplyTo: parsedEmail.messageId,
                    references: parsedEmail.references || parsedEmail.messageId
                };

                await transporter.sendMail(mailOptions);
                console.log(`  ✓ Auto-reply sent successfully to: ${targetEmail}`);

                await connection.addFlags(email.attributes.uid, ['\\Seen', '\\Answered']);
                console.log('  ✓ Email marked as Seen and Answered');

            } catch (emailErr) {
                console.error('Error processing individual email:', emailErr.message);
            }
        }

        connection.end();
        console.log('\n--- Auto-reply cycle completed ---\n');

    } catch (err) {
        console.error('IMAP Connection Error:', err.message);
        if (connection) {
            try { connection.end(); } catch (_) { }
        }
    }
}

const CHECK_INTERVAL = DEBUG_MODE ? DEBUG_TIME_CHECK * 1000 : PROD_TIME_CHECK * 1000;

autoReply();
setInterval(autoReply, CHECK_INTERVAL);

console.log('===========================================');
console.log('🚀 GasPro Email Auto-Reply Service Started');
console.log('===========================================');
console.log(`Mode: ${DEBUG_MODE ? 'DEBUG' : 'PRODUCTION'}`);
console.log(`Check interval: ${CHECK_INTERVAL / 1000} seconds`);
console.log(`Timezone: ${TIMEZONE}`);
console.log(`Active hours: 17:00 - 08:00 WIB`);
console.log('===========================================\n');