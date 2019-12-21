'use strict';

const SequelizeAuto = require('sequelize-auto')
const Sequelize = require('sequelize')
const fs = require('fs-extra')
const path = require('path')
const yaml = require('js-yaml')

module.exports = {
    reverse: reverse
};

let _config; 
let _auto;
let _sequelize;

function createSequelizeAuto() {
    if (!_auto) {
        const option = Object.assign({
            directory: false,
            /*
            additional: {
                timestamps: false
                //...
            },
            tables: ['table1', 'table2', 'table3']
            */
        }, _config);
        _auto = new SequelizeAuto(_config.database, _config.username, _config.password, option);
    }
    return _auto;
}

function createSequelize() {
    if (!_sequelize) {
        const option = Object.assign({}, _config);
        _sequelize = new Sequelize(_config.database, _config.username, _config.password, option);
    }
    return _sequelize;
}

function configure(conf) {
    _config = Object.assign({
        directory: false,
        host: 'localhost',
        port: 3306,
        dialect: 'mysql',
        output: '.a5doc',
    }, conf);
}

async function reverse(conf) {
    configure(conf);
    const infos = await readSchema();
    if (_config.dialect == 'mysql') {
        // コメントの取得は、mysqlにしか対応してません、追加で実装してください
        const comments = await readComment();
        fillComment(infos, comments);
        // インデックス情報取得も、mysqlにしか対応してません、追加で実装してください
        infos.indexes = await readIndex();
    }
    writeA5doc(infos);
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
  
function fillComment(infos, comments) {
    comments.forEach((comment) => {
        const table = infos.tables[comment.TABLE_NAME];
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

function writeA5doc(infos) {
    // console.log(JSON.stringify(infos, null, '  '));
    const a5Tables = {};
    Object.keys(infos.tables).forEach((tableId) => {
        const rTable = infos.tables[tableId];
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
    mergeIndex(a5Tables, infos.indexes);
    mergeForeignKeys(a5Tables, infos.foreignKeys);
    Object.keys(a5Tables).forEach(tableId => {
        const table = a5Tables[tableId];
        try {
            fs.statSync(_config.output);
        } catch (err) {
            fs.mkdirpSync(_config.output);
        }
        const file = path.join(_config.output, table.id + '.yml');
        const content = yaml.safeDump(table);
        fs.writeFileSync(file, content);
    });
}
