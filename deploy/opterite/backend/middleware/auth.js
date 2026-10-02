const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { CLEAR_COOKIE_OPTIONS } = require('../config/cookies');

const JWT_SECRET = env.jwtSecret;

function authenticateToken(req, res, next) {
    const token = req.cookies.auth_token;

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required',
            redirect: '/login'
        });
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

        return res.status(401).json({
            success: false,
            message: 'Invalid or expired token',
            redirect: '/login'
        });
    }
}

module.exports = {
    authenticateToken
};
