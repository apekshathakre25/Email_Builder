const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { CLEAR_COOKIE_OPTIONS } = require('../config/cookies');

// Sourced from validated config. There is deliberately no fallback here: a
// hardcoded default would let anyone forge a token if the env var went missing.
const JWT_SECRET = env.jwtSecret;


function authenticateToken(req, res, next) {
    const token = req.cookies.auth_token;

    if (!token) {

        if (req.path.startsWith('/api') || req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required',
                redirect: '/'
            });
        }

        return res.redirect('/');
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
            email: decoded.email,
            name: decoded.name
        };
        next();
    } catch (err) {
        console.error('[AUTH] Token verification failed:', err.message);
        res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);


        if (req.path.startsWith('/api') || req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or expired token',
                redirect: '/'
            });
        }

        return res.redirect('/');
    }
}


function redirectIfAuthenticated(req, res, next) {
    const token = req.cookies.auth_token;

    if (!token) {
        return next();
    }

    try {
        jwt.verify(token, JWT_SECRET);

        return res.redirect('/interface');
    } catch (err) {

        res.clearCookie('auth_token', CLEAR_COOKIE_OPTIONS);
        next();
    }
}

module.exports = {
    authenticateToken,
    redirectIfAuthenticated
};
