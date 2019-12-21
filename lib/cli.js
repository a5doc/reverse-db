#!/usr/bin/env node

const reverseDb = require('./reverse-db');
const argvOptions = {
    string: [
        'database',
        'username',
        'password',
        'host',
        'port',
        'dialect',
        'table',
        'output',
    ],
    alias: {
        d: 'database',
        u: 'username',
        p: 'password',
        h: 'host',
        P: 'port',
        D: 'dialect',
        t: 'table',
        o: 'output',
    },
    default: {
        host: 'localhost',
        port: 3306,
        dialect: 'mysql',
        output: '.a5doc',
        table: '-',
    },
    '--': true,
    stopEarly: true,
};
const argv = require('minimist')(process.argv.slice(2), argvOptions);
do {
    let valid = true;
    // stringで指定されている項目は全部必須なので、それだけチェックする
    const required = argvOptions.string.filter(a => !argv[a]);
    if (required.length > 0) {
        valid = false;
        console.error('必須パラメータがありません: ' + required.join(','));
    }
    if (!valid) {
        console.error('reverse-db の使い方が違うようです。こちらを見てください。https://github.com/a5doc/reverse-db');
        process.exit(1);
    }
} while (false);

const config = {
    database: argv.database,
    username: argv.username,
    password: argv.password,
    host: argv.host,
    port: argv.port,
    dialect: argv.dialect,
    tables: argv.table.split(/,/),
    output: argv.output,
};
if (config.tables.length == 1 && config.tables[0] == '-') {
    delete config.tables;
}

reverseDb.reverse(config)
.then(result => {
  console.log('Done');
})
.catch(err => {
  console.error('Error');
  console.error(err);
});
