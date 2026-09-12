
const { generateMessageId, validateMessageId } = require('./messageIdGenerator');

console.log('🧪 Testing Message-ID Generator\n');
console.log('='.repeat(80));


const testCases = [
    {
        name: 'Simple timestamp + random',
        template: '<[[timestamp]]-[[bigchar(6)]]-[[num(6)]]@{{Domain}}>',
        domain: 'example.com'
    },
    {
        name: 'Complex alphanumeric',
        template: '<[[mixsmallalphanum(32)]]@[[smallchar(5)]].{{Domain}}>',
        domain: 'yourdomain.com'
    },
    {
        name: 'Multiple random parts',
        template: '<[[num(1)]].[[mixsmallalphanum(16)]]@mg2.{{Domain}}>',
        domain: 'substack.com'
    },
    {
        name: 'PHP-style timestamp',
        template: '<infini8-<?=time()?>@infini8media.com>',
        domain: 'infini8media.com'
    },
    {
        name: 'All character types',
        template: '<[[bigchar(5)]]-[[smallchar(5)]]-[[num(5)]]-[[mixall(10)]]@{{Domain}}>',
        domain: 'test.com'
    },
    {
        name: 'Hex digits',
        template: '<[[hexdigit(16)]]@{{Domain}}>',
        domain: 'hextest.com'
    },
    {
        name: 'ASCII to Hex',
        template: '<[[ascii2hex(hello)]]-[[timestamp]]@{{Domain}}>',
        domain: 'ascii.com'
    },
    {
        name: 'Mixed alphanumeric variants',
        template: '<[[mixbigalphanum(10)]]-[[mixsmallalphanum(10)]]@{{Domain}}>',
        domain: 'mixed.com'
    },
    {
        name: 'Without angle brackets (should add them)',
        template: '[[timestamp]]-[[bigchar(8)]]@{{Domain}}',
        domain: 'auto.com'
    },
    {
        name: 'Empty template (should use default)',
        template: '',
        domain: 'default.com'
    }
];


testCases.forEach((test, index) => {
    console.log(`\n${index + 1}. ${test.name}`);
    console.log('-'.repeat(80));
    console.log(`Template: ${test.template || '(empty - will use default)'}`);
    console.log(`Domain:   ${test.domain}`);

    const result = generateMessageId(test.template, test.domain);
    const isValid = validateMessageId(result);

    console.log(`Result:   ${result}`);
    console.log(`Valid:    ${isValid ? '✅ Yes' : '❌ No'}`);


    if (test.template.includes('{{Domain}}')) {
        const hasDomain = result.includes(test.domain);
        console.log(`Domain replaced: ${hasDomain ? '✅ Yes' : '❌ No'}`);
    }
});


console.log('\n\n' + '='.repeat(80));
console.log('🔄 Testing Uniqueness (generating 5 Message-IDs from same template)');
console.log('='.repeat(80));

const uniquenessTemplate = '<[[timestamp]]-[[mixall(16)]]@{{Domain}}>';
const uniquenessDomain = 'unique.com';
const generated = new Set();

for (let i = 0; i < 5; i++) {
    const id = generateMessageId(uniquenessTemplate, uniquenessDomain);
    generated.add(id);
    console.log(`${i + 1}. ${id}`);


    const start = Date.now();
    while (Date.now() - start < 10) { }
}

console.log(`\n✅ All ${generated.size} Message-IDs are unique: ${generated.size === 5 ? 'Yes' : 'No'}`);

console.log('\n' + '='.repeat(80));
console.log('✅ All tests completed!');
console.log('='.repeat(80));
