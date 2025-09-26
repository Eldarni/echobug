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
            choices: [ 'Refresh Request/Correlation IDs', ...testFiles ]
        }
    ]);

    //
    if (action.action === 'Refresh Request/Correlation IDs') {
        
        //
        const updateIDAction = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'Select an action',
                choices: [ 'Both', 'Request ID', 'Correlation ID' ]
            }
        ]);

        //  
        if (updateIDAction.action === 'Both' || updateIDAction.action === 'Request ID') {
            requestID = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'requestID',
                    message: 'Enter the new request ID',
                    default: crypto.randomUUID()
                }
            ]);
        }

        //
        if (updateIDAction.action === 'Both' || updateIDAction.action === 'Correlation ID') {
            correlationID = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'correlationID',
                    message: 'Enter the new correlation ID',
                    default: crypto.randomUUID()
                }
            ]);
        }
    
    }

    //
    if (action.action.startsWith('Run Test')) {

        //
        const testFile = action.action.split(':')[1];
        let testData = fs.readFileSync(`${basePath}/${testFile.trim().replaceAll(' ', '-').toLowerCase()}.json`, 'utf8');

        //
        testData = testData.replace('{{REQUESTID}}', requestID);
        testData = testData.replace('{{CORRELATIONID}}', correlationID);


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