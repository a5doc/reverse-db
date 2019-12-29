'use strict';

const SequelizeAuto = require('sequelize-auto');
const Sequelize = require('sequelize');
const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const frontMatter = require('front-matter');
const glob = require('glob');
const prettier = require('prettier');
const _ = require('lodash');

const Format = {
    yaml: 'yaml',
    frontMatter: 'front-matter',
    json: 'json',
};

module.exports = {
    reverse: reverse,
    Format: Format,
};

let _config; 
let _auto;
let _sequelize;

function createSequelizeAuto() {
    if (!_auto) {
        const option = _.merge({
            directory: false,
            /*
            additional: {
                timestamps: false
                //...
            },
            tables: ['table1', 'table2', 'table3']
            */
        }, _config);
        // インデックスとかFKとかのために全テーブルを読む
        delete option.tables;
        _auto = new SequelizeAuto(_config.database, _config.username, _config.password, option);
    }
    return _auto;
}

function createSequelize() {
    if (!_sequelize) {
        const option = _.merge({}, _config);
        _sequelize = new Sequelize(_config.database, _config.username, _config.password, option);
    }
    return _sequelize;
}

function configure(conf) {
    _config = _.merge({
        directory: false,
        host: 'localhost',
        port: 3306,
        dialect: 'mysql',
        output: '.a5doc',
        format: Format.frontMatter,
    }, conf);
    _config.output = _config.output.replace(/\\/g, '/');
}

async function reverse(conf) {
    configure(conf);
    const schema = await readSchema();
    if (_config.dialect == 'mysql') {
        // コメントの取得は、mysqlにしか対応してません、追加で実装してください
        const comments = await readComment();
        fillComment(schema, comments);
        // インデックス情報取得も、mysqlにしか対応してません、追加で実装してください
        schema.indexes = await readIndex();
    }
    writeA5doc(schema);
}

async function readSchema() {
    const auto = createSequelizeAuto();
    return new Promise((resolve, reject) => {
        auto.run((err) => {
            if (err) {
                reject(err);
            } else {
                resolve({
                    tables: auto.tables,
                    foreignKeys: auto.foreignKeys,
                });
            }
        });
    });
}
  
async function readComment() {
    const sequelize = createSequelize();
    let sql = `
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = :databaseName`;
    const replacements = {
        databaseName: _config.database,
    };
    if (_config.tables) {
        sql += ` AND TABLE_NAME IN(:tables)`;
        replacements.tables = _config.tables;
    }
    return sequelize.query(sql, {replacements, type: sequelize.QueryTypes.SELECT});
}
  
function fillComment(schema, comments) {
    comments.forEach((comment) => {
        const table = schema.tables[comment.TABLE_NAME];
        const column = table[comment.COLUMN_NAME];
        column.comment = comment.COLUMN_COMMENT;
    });
}
  
async function readIndex() {
    const sequelize = createSequelize();
    let sql = `
        SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = :databaseName
        ORDER BY TABLE_NAME, SEQ_IN_INDEX`;
    const replacements = {
        databaseName: _config.database,
    };
    if (_config.tables) {
        sql += ` AND TABLE_NAME IN(:tables)`;
        replacements.tables = _config.tables;
    }
    return sequelize.query(sql, {replacements, type: sequelize.QueryTypes.SELECT});
}
  
function mergeIndex(a5Tables, indexes) {
    indexes.forEach((row) => {
        const table = a5Tables[row.TABLE_NAME];
        if (!table.indexes) {
            table.indexes = {};
        }
        if (row.NON_UNIQUE == 0 && row.INDEX_NAME == 'PRIMARY') {
            return;
        }
        if (!table.indexes[row.INDEX_NAME]) {
            table.indexes[row.INDEX_NAME] = {};
        }
        const index = table.indexes[row.INDEX_NAME];
        index.type = row.NON_UNIQUE == 0 ? 'unique' : 'non-unique';
        if (!index.columns) {
            index.columns = [];
        }
        index.columns.push(row.COLUMN_NAME);
    });
}
  
function mergeForeignKeys(a5Tables, foreignKeys) {
    Object.keys(foreignKeys).forEach((tableId) => {
        const table = a5Tables[tableId];
        if (!table.foreignKeys) {
            table.foreignKeys = {};
        }
        const fks = foreignKeys[tableId];
        Object.keys(fks).forEach((fkId) => {
            const fkRaw = fks[fkId];
            if (fkRaw.isPrimaryKey || fkRaw.isUnique) {
                return;
            }
            if (fkRaw.target_table == null && fkRaw.target_column == null) {
                // この場合はインデックスなので、indexes にすでにあるハズ
                if (table.indexes[fkRaw.constraint_name]) {
                    return;
                }
                console.error(fkRaw);
                throw new Error('想定されていないFK');
            }
            if (!fkRaw.isForeignKey) {
                console.error(fkRaw);
                throw new Error('想定されていないFK');
            }
            if (fkRaw.source_table != fkRaw.source_schema ||
                fkRaw.source_table != fkRaw.target_schema) {
                console.error(fkRaw);
                throw new Error('想定されていないFK');
            }
            if (fkRaw.source_column != fkRaw.foreignSources.source_column ||
                fkRaw.target_table != fkRaw.foreignSources.target_table ||
                fkRaw.target_column != fkRaw.foreignSources.target_column) {
                console.error(fkRaw);
                throw new Error('想定されていないFK');
            }
            table.foreignKeys[fkRaw.constraint_name] = {
                columns: [fkRaw.source_column],
                references: {
                    tableId: fkRaw.target_table,
                    columns: [fkRaw.target_column],
                },
                relationType: '0N:1',
            };
        });
    });
}

function writeA5doc(schema) {
    // console.log(JSON.stringify(schema, null, '  '));
    const a5Tables = {};
    Object.keys(schema.tables).forEach((tableId) => {
        const rTable = schema.tables[tableId];
        const a5Table = {
            id: tableId,
            name: tableId,
            category: '',
            description: '',
            columns: {},
            primary: [],
            indexes: {},
            foreignKeys: {},
        };
        Object.keys(rTable).forEach((columnId) => {
            const rColumn = rTable[columnId];
            const a5C = {};
            const typeM = rColumn.type.match(/(.+?)\((.*?)\)/);
            a5C['name'] = rColumn.comment ? rColumn.comment: columnId;
            a5C.type = rColumn.type;
            if (typeM) {
                a5C.type = typeM[1];
                a5C.length = typeM[2] - 0;
            }
            if (rColumn.allowNull) {
                a5C.notNull = false;
            }
            if (rColumn.foreignKey && rColumn.foreignKey.extra && rColumn.foreignKey.extra == 'auto_increment') {
                a5C.autoIncrement = true;
            }
            if (rColumn.defaultValue != null) {
                a5C.defaultValue = rColumn.defaultValue;
            }
            if (rColumn.primaryKey) {
                a5Table.primary.push(columnId);
            }
            a5Table.columns[columnId] = a5C;
        });
        a5Tables[tableId] = a5Table;
    });
    mergeIndex(a5Tables, schema.indexes);
    mergeForeignKeys(a5Tables, schema.foreignKeys);
    const tableIds = _config.tables ? _config.tables: Object.keys(schema.tables);
    tableIds.forEach(tableId => {
        const table = a5Tables[tableId];
        try {
            fs.statSync(_config.output);
        } catch (err) {
            fs.mkdirpSync(_config.output);
        }
        if (_config.format == Format.yaml) {
            const doc = findOrCreateYmlDoc(tableId);
            doc.data = table;
            const content = yaml.safeDump(doc.data);
            fs.writeFileSync(doc.file, content);
        } else if (_config.format == Format.frontMatter) {
            const doc = findOrCreateMdDoc(tableId, table.name);
            doc.data.attributes.schema = table;
            writeMd(doc);
        } else if (_config.format == Format.json) {
            const doc = findOrCreateJsonDoc(tableId);
            doc.data = table;
            const content = JSON.stringify(doc.data, null, 2);
            fs.writeFileSync(doc.file, content);
        } else {
            throw new Error(`unknown format: ${_config.format}`);
        }
    });
}

function beautify(text, options) {
    const prettierOptions = _.merge({
        parser: 'markdown',
    }, options);
    return prettier.format(text, prettierOptions);
}

const _docs = {};

function findOrCreateMdDoc(tableId, tableName) {
    if (Object.keys(_docs).length === 0) {
        readAll(`${_config.output}/**/*.md`)
            .forEach(doc => {
                const data = frontMatter(doc.content);
                const id = data.attributes.schema.id;
                _docs[id] = initMdDoc({
                    file: doc.file,
                    data: data,
                }, id, data.attributes.schema.name);
            });
    }
    if (!_docs[tableId]) {
        _docs[tableId] = initMdDoc({}, tableId, tableName);
    }
    return _docs[tableId];
}

function findOrCreateYmlDoc(tableId) {
    if (Object.keys(_docs).length === 0) {
        readAll(`${_config.output}/**/*.yml`)
            .forEach(doc => {
                const data = yaml.safeLoad(doc.content);
                _docs[data.id] = initSimpleDoc({
                    file: doc.file,
                    data: data,
                }, data.id, '.yml');
            });
    }
    if (!_docs[tableId]) {
        _docs[tableId] = initSimpleDoc({}, tableId, '.yml');
    }
    return _docs[tableId];
}

function findOrCreateJsonDoc(tableId) {
    if (Object.keys(_docs).length === 0) {
        readAll(`${_config.output}/**/*.json`)
            .forEach(doc => {
                const data = JSON.parse(doc.content);
                _docs[data.id] = initSimpleDoc({
                    file: doc.file,
                    data: data,
                }, data.id, '.json');
            });
    }
    if (!_docs[tableId]) {
        _docs[tableId] = initSimpleDoc({}, tableId, '.json');
    }
    return _docs[tableId];
}

function initMdDoc(doc, tableId, tableName) {
    const mdDoc = {
        file: path.join(_config.output, tableId + '.md'),
        data: {
            attributes: {
                docId: tableId,
                title: tableName,
                schema: {
                    id: tableId,
                },
            },
            body: '',
        }
    };
    return _.merge(mdDoc, doc);
}

function initSimpleDoc(doc, tableId, fileExt) {
    const newDoc = {
        file: path.join(_config.output, tableId + fileExt),
        data: {},
    };
    return _.merge(newDoc, doc);
}

function readAll(pattern) {
    const files = glob.sync(pattern);
    const docs = [];
    files.forEach(file => {
        const content = fs.readFileSync(file, 'utf8');
        docs.push({
            file: file,
            content: content,
        });
    });
    return docs;
}

function writeMd(doc) {
    // front-matter
    const fm = yaml.safeDump(doc.data.attributes);
    // MDを整形する
    const content = beautify(doc.data.body);
    // MDを出力する
    const md = `---\n${fm}---\n\n${content}`;
    try {
      fs.statSync(path.dirname(doc.file));
    } catch (err) {
      fs.mkdirpSync(path.dirname(doc.file));
    }
    fs.writeFileSync(doc.file, md);
    return doc;
  }
  