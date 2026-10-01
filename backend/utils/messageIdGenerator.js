function generateRandom(charset, length) {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return result;
}

function asciiToHex(text) {
    return text.split('').map(char => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function generateRFCDate(timezone) {
    const now = new Date();

    const timezoneOffsets = {
        'UTC': '+0000',
        'EST': '-0500',
        'EDT': '-0400',
        'IST': '+0530'
    };

    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));

    const dayName = days[istTime.getUTCDay()];
    const day = istTime.getUTCDate().toString().padStart(2, '0');
    const month = months[istTime.getUTCMonth()];
    const year = istTime.getUTCFullYear();
    const hours = istTime.getUTCHours().toString().padStart(2, '0');
    const minutes = istTime.getUTCMinutes().toString().padStart(2, '0');
    const seconds = istTime.getUTCSeconds().toString().padStart(2, '0');
    const offset = timezoneOffsets[timezone] || '+0530';

    return `${dayName}, ${day} ${month} ${year} ${hours}:${minutes}:${seconds} ${offset}`;
}

function processPlaceholder(placeholder, domain = 'example.com') {

    placeholder = placeholder.trim();

    const match = placeholder.match(/^([a-zA-Z_0-9]+)\(([^)]*)\)$/);
    if (!match) {

        if (placeholder === 'timestamp') {
            return Math.floor(Date.now() / 1000).toString();
        }
        return placeholder;
    }

    const [, funcName, param] = match;
    const length = parseInt(param) || 0;

    const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
    const DIGITS = '0123456789';
    const HEX = '0123456789abcdef';

    switch (funcName.toLowerCase()) {

        case 'bigchar':
            return generateRandom(UPPERCASE, length);

        case 'smallchar':
            return generateRandom(LOWERCASE, length);

        case 'mixsmallbigchar':
            return generateRandom(LOWERCASE + UPPERCASE, length);

        case 'num':
            return generateRandom(DIGITS, length);

        case 'mixsmallalphanum':
            return generateRandom(LOWERCASE + DIGITS, length);

        case 'mixbigalphanum':
            return generateRandom(UPPERCASE + DIGITS, length);

        case 'mixall':
            return generateRandom(LOWERCASE + UPPERCASE + DIGITS, length);

        case 'hexdigit':
            return generateRandom(HEX, length);

        case 'ascii2hex':
            return asciiToHex(param);

        case 'rfc_date_utc':
            return generateRFCDate('UTC');

        case 'rfc_date_est':
            return generateRFCDate('EST');

        case 'rfc_date_edt':
            return generateRFCDate('EDT');

        case 'rfc_date_ist':
            return generateRFCDate('IST');

        default:
            return placeholder;
    }
}

function generateMessageId(template, domain = 'example.com') {
    if (!template || !template.trim()) {
        const timestamp = Math.floor(Date.now() / 1000);
        const random = generateRandom('abcdefghijklmnopqrstuvwxyz0123456789', 16);
        return `<${timestamp}.${random}@${domain}>`;
    }

    let result = template;

    result = result.replace(/\{\{Domain\}\}/gi, domain);

    result = result.replace(/<\?=time\(\)\?>/g, () => {
        const now = new Date();

        const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
        const year = istTime.getUTCFullYear();
        const month = String(istTime.getUTCMonth() + 1).padStart(2, '0');
        const day = String(istTime.getUTCDate()).padStart(2, '0');
        const hours = String(istTime.getUTCHours()).padStart(2, '0');
        const minutes = String(istTime.getUTCMinutes()).padStart(2, '0');
        const seconds = String(istTime.getUTCSeconds()).padStart(2, '0');
        return `${year}${month}${day}${hours}${minutes}${seconds}`;
    });

    result = result.replace(/\[\[timestamp\]\]/gi, Math.floor(Date.now() / 1000).toString());

    const placeholderRegex = /\[\[([^\]]+)\]\]/g;
    result = result.replace(placeholderRegex, (match, placeholder) => {
        return processPlaceholder(placeholder, domain);
    });

    result = result.trim();
    if (!result.startsWith('<')) {
        result = '<' + result;
    }
    if (!result.endsWith('>')) {
        result = result + '>';
    }

    return result;
}

function validateMessageId(messageId) {
    const messageIdRegex = /^<[^<>@\s]+@[^<>@\s]+>$/;
    return messageIdRegex.test(messageId);
}

module.exports = {
    generateMessageId,
    validateMessageId,
    processPlaceholder
};
