#!/usr/bin/env node

//
import { Command } from 'commander';
import inquirer from 'inquirer';

//
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

//
const program = new Command();

//
program
    .name('echobug-test')
    .description('A CLI tool for sending test data to EchoBug')
    .version('1.0.0')
    .option('-h, --host <host>', 'Host to send the test data to', 'localhost')
    .option('-p, --port <port>', 'Port to send the test data to', 3333)
    .option('-v, --verbose', 'Verbose output')

//
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error.message);
    process.exit(1);
});

//
process.on('unhandledRejection', (reason, promise) => {

    //
    if (String(reason).startsWith('ExitPromptError')) {
        console.log('Bye!');
        process.exit(0);
    }

    //
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);

});

//
program.parse();

//
const options = program.opts();

//
if (options.verbose) {
    console.log('Debug mode is enabled');
    console.log('Options:', options);
}

//
if (!options.host) {
    console.error('Host is required');
    process.exit(1);
}

//
if (!options.port) {
    console.error('Port is required');
    process.exit(1);
}

//
const basePath = path.dirname(url.fileURLToPath(import.meta.url));

//
let requestID     = crypto.randomUUID();
let correlationID = crypto.randomUUID();

//
const testFiles = fs.readdirSync(basePath).filter(file => file.endsWith('.json')).map(file => {
    return `Run Test: ${file.replace('.json', '').replaceAll('-', ' ').replace(/\b\w/g, char => char.toUpperCase())}`;
});

//
async function startPrompts() {

    //
    const action = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Select an action',
            choices: [ 'Generate Event', ...testFiles ]
        }
    ]);

    //
    if (action.action === 'Generate Event') {

        //
        const eventType = await inquirer.prompt([
            {
                type: 'list',
                name: 'type',
                message: 'Select the event type',
                choices: [ 'message' ]
            }
        ]);

        //
        if (eventType.type === 'message') {
            await generateAndSendMessage();
        }

    }

    //
    if (action.action.startsWith('Run Test')) {

        //
        const testFile = action.action.split(':')[1];
        let testData = fs.readFileSync(`${basePath}/${testFile.trim().replaceAll(' ', '-').toLowerCase()}.json`, 'utf8');

        //
        !options.verbose && console.log(`Sending test: ${testFile}`);

        //
        options.verbose && console.log(`Sent: ${testData}`);
        
        //
        const socket = new net.Socket();
        socket.connect(options.port, options.host);
        socket.write(testData);
        socket.end();
       
    }

    //
    startPrompts();

}

//
startPrompts();

//
async function generateAndSendMessage() {

    //
    const message = await inquirer.prompt([
        {
            type: 'input',
            name: 'quantity',
            message: 'Enter the number of messages to send',
            default: 1
        },
        {
            type: 'list',
            name: 'type',
            message: 'Select the message type',
            choices: [ 'random', 'log', 'info', 'warn', 'error' ]
        },
        {
            type: 'input',
            name: 'label',
            message: 'Enter the message label (optional)',
            default: null
        },
        {
            type: 'input',
            name: 'value',
            message: 'Enter the message content (leave blank for random)',
            default: null
        },
        {
            type: 'input',
            name: 'file',
            message: 'Enter the message file (leave blank for random)',
            default: null
        },
        {
            type: 'input',
            name: 'line',
            message: 'Enter the message line (leave blank for random)',
            default: null
        }
    ]);

    //
    let events = [];

    //
    for (let i = 0; i < message.quantity; i++) {

        //
        const event = { type: message.type, label: message.label, value: message.value, file: message.file, line: message.line };

        //
        if (event.type === 'random') {
            const randomTypes = ['log', 'info', 'warn', 'error'];
            event.type = randomTypes[Math.floor(Math.random() * randomTypes.length)];
        }

        //
        if (event.label === null) {
            delete event.label;
        }

        //
        if (event.value === null) {

            //
            const randomMessages = {
                'log'   : ['Request received at /api/healthcheck',  'Session token parsed successfully',  'Configuration file loaded from ./config/app.json',  'Middleware chain executed for route /api/users',  'HTTP headers validated for request id=af32c1',  'Cache lookup attempted for key=user_102',  'Response serialized to JSON in 3m'],
                'info'  : ['Application started on port 3000', 'User authenticated: user_id=102', 'Scheduled job executed: cleanup-cache', 'Connected to external API: payments-service', 'File upload completed: filename=report.pdf', 'Background worker started: worker_id=7', 'Metrics collected: uptime=3600s', 'Graceful shutdown initiated by signal SIGTERM'],
                'warn'  : ['Disk usage at 78% capacity', 'API response time exceeded threshold: 1200ms', 'Deprecated endpoint accessed: /v1/orders', 'Retry attempt 2 for message queue publish', 'Memory usage approaching limit: 85%', 'User session expired: session_id=xyz123', 'Configuration value missing, using default', 'Slow query detected: SELECT * FROM orders (2.3s)'],
                'error' : ['Database connection failed: timeout after 5000ms', 'Unhandled exception in request handler: TypeError', 'Failed to write file to /var/data/output.json (permission denied)', 'Payment processing failed: insufficient funds', 'External API call failed: 503 Service Unavailable', 'Worker process crashed with exit code 1', 'Email delivery failed: invalid recipient address', 'Data validation error: missing required field \'email\'', 'File system error: no space left on device'],
            };

            //
            event.value = randomMessages[event.type][Math.floor(Math.random() * randomMessages[event.type].length)];

        }

        //
        if (event.file === null) {
            const randomFiles = ['index.js', 'app.js', 'server.js', 'main.js', 'app.ts', 'server.ts', 'main.ts'];
            event.file = randomFiles[Math.floor(Math.random() * randomFiles.length)];
        }

        //
        if (event.line === null) {
            event.line = Math.floor(Math.random() * 1000) + 1;
        }

        //
        events.push({ requestID, correlationID, ...event });

    }

    //
    !options.verbose && console.log(`Sending ${message.quantity} events`);

    //
    options.verbose && console.log('Sent:', JSON.stringify(events, null, 4));

    //
    const socket = new net.Socket();
    socket.connect(options.port, options.host);
    socket.write(JSON.stringify(events));
    socket.end();

}