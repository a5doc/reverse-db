'use strict';

const SequelizeAuto = require('sequelize-auto')
const Sequelize = require('sequelize')
const fs = require('fs-extra')
const path = require('path')
const yaml = require('js-yaml')

let config; 

function reverse(conf) {
    config = conf;
    let infos;
    readSchema()
        .then(results => {
            infos = results;
            return readComment();
        })
        .then(comments => {
            fillComment(infos, comments);
            convertA5doc(infos);
        });
}
module.exports.reverse = reverse;

function readSchema() {
    const option = Object.assign({
        directory: false,
        /*
        additional: {
            timestamps: false
            //...
        },
        tables: ['table1', 'table2', 'table3']
        */
    }, config);
    const auto = new SequelizeAuto(config.database, config.username, config.password, option);
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
  
function readComment() {
    const option = Object.assign({}, config);
    if (option.dialect != 'mysql') {
        // mysqlにしか対応してません、追加で実装してください
        return Promise.resolve([]);
    }
    const sequelize = new Sequelize(config.database, config.username, config.password, option);
    let sql = `
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = :databaseName`;
    const replacements = {
        databaseName: config.database,
    };
    if (config.tables) {
        sql += ` AND TABLE_NAME IN(:tables)`;
        replacements.tables = config.tables;
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

function convertA5doc(infos) {
    // console.log(JSON.stringify(infos, null, '  '));
    const a5Tables = [];
    Object.keys(infos.tables).forEach((tableId) => {
        const rTable = infos.tables[tableId];
        const a5Table = {
            id: tableId,
            name: tableId,
            category: '',
            description: '',
            columns: {},
            primary: [],
            indexes: [],
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
        a5Tables.push(a5Table);
    });
    a5Tables.forEach(table => {
        try {
            fs.statSync(config.output);
        } catch (err) {
            fs.mkdirSync(config.output);
        }
        const file = path.join(config.output, table.id + '.yml');
        const content = yaml.safeDump(table);
        fs.writeFileSync(file, content);
    });
}
