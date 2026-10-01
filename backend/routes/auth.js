const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const logger = require('../utils/logger');
const env = require('../config/env');
const otpStore = require('../utils/otpStore');
const { sendTransactionalEmail } = require('../utils/brevoMailer');
const { otpRequestLimiter, loginLimiter } = require('../middleware/rateLimit');
const { COOKIE_OPTIONS, CLEAR_COOKIE_OPTIONS } = require('../config/cookies');

const AUTHORIZED_USERS = env.authorizedUsers;

const JWT_SECRET = env.jwtSecret;

/**
 * Google OAuth is the one flow that cannot answer with JSON.
 *
 * It is a top-level browser redirect: the browser leaves the app, visits Google,
 * and comes back to /auth/google/callback, which has to redirect it *somewhere*.
 * The redirect belongs to the SPA's router and is therefore absolute when the
 * frontend has its own origin.
 *
 * FRONTEND_URL unset means "the frontend is served from this origin", which
 * keeps redirects relative for a same-origin SPA deployment.
 */
const FRONTEND_ORIGIN = env.frontendUrl;

function frontendPath(path) {
    return FRONTEND_ORIGIN ? `${FRONTEND_ORIGIN}${path}` : path;
}

const POST_LOGIN_REDIRECT = frontendPath('/');

// passport reads failureRedirect once, when the middleware is constructed, so it
// has to be resolved here rather than per request.
const LOGIN_FAILURE_REDIRECT = frontendPath('/login?error=unauthorized');

function findAuthorizedUser(email) {
    if (!email || typeof email !== 'string') return undefined;
    const normalized = email.trim().toLowerCase();
    return AUTHORIZED_USERS.find(u => u.email === normalized);
}

function otpMatches(supplied, expected) {
    const a = Buffer.from(String(supplied));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

if (env.google.enabled) {
    passport.use(new GoogleStrategy({
        clientID: env.google.clientId,
        clientSecret: env.google.clientSecret,
        callbackURL: env.google.callbackUrl
    },
        async (accessToken, refreshToken, profile, done) => {
            try {
                const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;

                if (!email) {
                    return done(null, false, { message: 'No email found in Google profile' });
                }

                const user = findAuthorizedUser(email);

                if (!user) {
                    console.log(`[GOOGLE AUTH] Unauthorized login attempt: ${email}`);
                    return done(null, false, { message: 'Unauthorized: Your email is not in the authorized users list' });
                }

                logger.info(`[GOOGLE AUTH] Authorized user logged in: ${email}`);
                return done(null, { email: user.email, name: user.name });
            } catch (error) {
                logger.error('[GOOGLE AUTH] Error:', error);
                return done(error, null);
            }
        }));
} else {
    console.warn('[AUTH] Google OAuth credentials (GOOGLE_CLIENT_ID/SECRET) not found. Google login will be disabled.');
}

passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

router.post('/send-otp', otpRequestLimiter, async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        const user = findAuthorizedUser(email);
        if (!user) {
            return res.status(403).json({ success: false, message: 'Unauthorized user' });
        }

        const otp = String(crypto.randomInt(100000, 1000000));

        await otpStore.set(user.email, otp);

        logger.debug(`[OTP DEBUG] OTP for ${user.email} is: ${otp}`);

        try {

            await sendTransactionalEmail({
                to: user.email,
                toName: user.name,
                subject: 'Your Login OTP - Opterite',
                html: `
                    <!DOCTYPE html>
                    <html lang="en">
                    <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <meta http-equiv="X-UA-Compatible" content="IE=edge">
                        <title>Login OTP</title>
                        <style>
                            @media only screen and (max-width: 600px) {
                                .email-container {
                                    width: 100% !important;
                                    max-width: 100% !important;
                                }
                                .content-padding {
                                    padding: 20px 15px !important;
                                }
                                .header-padding {
                                    padding: 30px 20px !important;
                                }
                                .otp-text {
                                    font-size: 32px !important;
                                    letter-spacing: 5px !important;
                                }
                                .otp-box {
                                    padding: 20px !important;
                                }
                                h1 {
                                    font-size: 22px !important;
                                }
                                h2 {
                                    font-size: 18px !important;
                                }
                                .logo-img {
                                    width: 50px !important;
                                    height: 50px !important;
                                }
                            }
                        </style>
                    </head>
                    <body style="margin: 0; padding: 0; background-color: #f4f7fa; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
                        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f4f7fa; padding: 20px 10px;">
                            <tr>
                                <td align="center">
                                    <table class="email-container" width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1); max-width: 600px; width: 100%;">
                                        <tr>
                                            <td class="header-padding" style="background: linear-gradient(135deg, #007bff 0%, #0056b3 100%); padding: 40px 30px; text-align: center;">
                                                <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 600;">
                                                    Opterite
                                                </h1>
                                                <p style="color: #e7f1ff; margin: 10px 0 0 0; font-size: 14px;">Secure Login Verification</p>
                                            </td>
                                        </tr>

                                        <tr>
                                            <td class="content-padding" style="padding: 40px 30px;">
                                                <h2 style="color: #343a40; margin: 0 0 20px 0; font-size: 22px; font-weight: 600;">
                                                    Hello ${user.name}! 👋
                                                </h2>

                                                <p style="color: #6c757d; line-height: 1.6; margin: 0 0 25px 0; font-size: 15px;">
                                                    You've requested to log in to your Opterite Interface. Please use the One-Time Password (OTP) below to complete your authentication:
                                                </p>

                                                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 30px 0;">
                                                    <tr>
                                                        <td align="center">
                                                            <table cellpadding="0" cellspacing="0" border="0" class="otp-box" style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); border: 2px dashed #007bff; border-radius: 10px; padding: 30px; margin: 0 auto;">
                                                                <tr>
                                                                    <td align="center">
                                                                        <p style="color: #6c757d; margin: 0 0 10px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; font-weight: 600;">Your OTP Code</p>
                                                                        <h1 class="otp-text" style="color: #007bff; margin: 0; font-size: 42px; letter-spacing: 8px; font-weight: 700; font-family: 'Courier New', monospace;">
                                                                            ${otp}
                                                                        </h1>
                                                                    </td>
                                                                </tr>
                                                            </table>
                                                        </td>
                                                    </tr>
                                                </table>

                                                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 6px; margin: 25px 0;">
                                                    <tr>
                                                        <td style="padding: 15px;">
                                                            <p style="color: #856404; margin: 0; font-size: 14px; line-height: 1.5;">
                                                                ⏰ <strong>Important:</strong> This OTP will expire in <strong>5 minutes</strong> for security reasons.
                                                            </p>
                                                        </td>
                                                    </tr>
                                                </table>

                                                <p style="color: #6c757d; line-height: 1.6; margin: 25px 0 0 0; font-size: 14px;">
                                                    If you didn't request this OTP, please ignore this email or contact +91 9307349162 if you have concerns about your account security.
                                                </p>
                                            </td>
                                        </tr>

                                        <tr>
                                            <td class="content-padding" style="background-color: #f8f9fa; padding: 25px 30px; border-top: 1px solid #dee2e6;">
                                                <h3 style="color: #495057; margin: 0 0 15px 0; font-size: 16px; font-weight: 600;">
                                                    🛡️ Security Tips
                                                </h3>
                                                <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                    <tr>
                                                        <td style="color: #6c757d; font-size: 13px; line-height: 1.8; padding: 3px 0;">• Never share your OTP with anyone</td>
                                                    </tr>
                                                    <tr>
                                                        <td style="color: #6c757d; font-size: 13px; line-height: 1.8; padding: 3px 0;">• Always verify the sender's email address</td>
                                                    </tr>
                                                    <tr>
                                                        <td style="color: #6c757d; font-size: 13px; line-height: 1.8; padding: 3px 0;">• Use a secure internet connection when logging in</td>
                                                    </tr>
                                                </table>
                                            </td>
                                        </tr>

                                        <tr>
                                            <td style="background-color: #343a40; padding: 25px 30px; text-align: center;">
                                                <p style="color: #adb5bd; margin: 0 0 10px 0; font-size: 13px;">
                                                    © 2026 Opterite. All rights reserved.
                                                </p>
                                                <p style="color: #6c757d; margin: 0; font-size: 12px;">
                                                    This is an automated message, please do not reply to this email.
                                                </p>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                    </body>
                    </html>
                `
            });
            console.log(`[OTP] Email sent successfully to ${user.email}`);
        } catch (emailError) {

            if (emailError.isConfigurationError) {
                console.error('[OTP] Email not sent, Brevo is not configured:', emailError.message);

                return res.status(500).json({
                    success: false,
                    message: `OTP email is not configured on this server: ${emailError.message}. Please contact support.`
                });
            }

            console.error('[OTP] Email sending failed:', emailError.message);

            return res.status(502).json({
                success: false,
                message: env.isProduction
                    ? `Could not send the OTP email (${emailError.message}). Please try again shortly or contact support.`
                    : `Could not send the OTP email (${emailError.message}). In development the code is printed to the server console.`
            });
        }

        res.json({ success: true, message: 'OTP sent successfully!' });
    } catch (err) {
        console.error('Error sending OTP:', err);
        res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
});

router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ success: false, message: 'Email and OTP are required' });
        }

        const user = findAuthorizedUser(email);
        if (!user) {
            return res.status(403).json({ success: false, message: 'Unauthorized user' });
        }

        const storedOtpData = await otpStore.get(user.email);

        if (!storedOtpData) {
            return res.status(400).json({
                success: false,
                message: 'OTP not found or expired. Please request a new one.'
            });
        }

        if (storedOtpData.attempts >= otpStore.MAX_ATTEMPTS) {
            await otpStore.remove(user.email);
            return res.status(400).json({ success: false, message: 'Too many failed attempts. Please request a new OTP.' });
        }

        if (!otpMatches(otp, storedOtpData.otp)) {
            const attempts = await otpStore.recordFailedAttempt(user.email);
            const remaining = Math.max(0, otpStore.MAX_ATTEMPTS - attempts);

            if (remaining === 0) {
                await otpStore.remove(user.email);
                return res.status(400).json({
                    success: false,
                    message: 'Too many failed attempts. Please request a new OTP.'
                });
            }

            return res.status(400).json({
                success: false,
                message: `Invalid OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
            });
        }

        await otpStore.remove(user.email);

        const token = jwt.sign(
            {
                email: user.email,
                name: user.name
            },
            JWT_SECRET,
            { expiresIn: '1d' }
        );

        res.cookie('auth_token', token, COOKIE_OPTIONS);

        console.log(`[AUTH] User ${email} logged in successfully`);

        res.json({
            success: true,
            message: 'Login successful',
            user: {
                email: user.email,
                name: user.name
            }
        });
    } catch (err) {
        console.error('Error during login:', err);
        res.status(500).json({ success: false, message: 'Login failed' });
    }
});

router.post('/logout', (req, res) => {
    res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
    res.json({ success: true, message: 'Logged out successfully' });
});

router.get('/check-auth', (req, res) => {
    const token = req.cookies.auth_token;

    if (!token) {
        return res.json({ authenticated: false });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({
            authenticated: true,
            user: {
                email: decoded.email,
                name: decoded.name
            }
        });
    } catch (err) {
        res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
        res.json({ authenticated: false });
    }
});

router.get('/auth/google', (req, res, next) => {
    if (!env.google.enabled) {
        console.error('[AUTH] Google login attempted but credentials are missing');
        return res.status(503).send('Google Login is not configured on this server. Please contact support.');
    }

    const token = req.cookies.auth_token;

    if (token) {
        try {

            jwt.verify(token, JWT_SECRET);

            console.log('[GOOGLE AUTH] User already logged in, redirecting to the app');
            return res.redirect(POST_LOGIN_REDIRECT);
        } catch (err) {

            console.log('[GOOGLE AUTH] Invalid token, proceeding with Google login');
        }
    }

    next();
}, passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false
}));

router.get('/auth/google/callback',
    passport.authenticate('google', {
        session: false,
        failureRedirect: LOGIN_FAILURE_REDIRECT
    }),
    (req, res) => {
        try {

            const token = jwt.sign(
                { email: req.user.email, name: req.user.name },
                JWT_SECRET,
                { expiresIn: '1d' }
            );

            // sameSite is widened to at least 'lax' because this response IS the
            // top-level redirect back from Google: a Strict cookie is not sent on
            // a cross-site navigation, so the browser would arrive at the app
            // without it and the login would appear to have failed. A deployment
            // configured for 'none' keeps 'none' — narrowing it to 'lax' here
            // would break the genuinely cross-site case this setting exists for.
            const oauthSameSite = COOKIE_OPTIONS.sameSite === 'none' ? 'none' : 'lax';

            res.cookie('auth_token', token, { ...COOKIE_OPTIONS, sameSite: oauthSameSite });

            console.log(`[GOOGLE AUTH] JWT token generated for ${req.user.email}`);

            res.redirect(POST_LOGIN_REDIRECT);
        } catch (error) {
            console.error('[GOOGLE AUTH] Error generating token:', error);
            res.redirect(frontendPath('/?error=auth_failed'));
        }
    }
);

module.exports = router;
