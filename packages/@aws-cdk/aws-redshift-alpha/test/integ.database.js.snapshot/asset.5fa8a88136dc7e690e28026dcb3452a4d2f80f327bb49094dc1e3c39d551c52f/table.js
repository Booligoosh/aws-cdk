"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const redshift_data_1 = require("./redshift-data");
const types_1 = require("./types");
const util_1 = require("./util");
async function handler(props, event) {
    const tableNamePrefix = props.tableName.prefix;
    const tableNameSuffix = props.tableName.generateSuffix === 'true' ? `${event.StackId.substring(event.StackId.length - 12)}` : '';
    const tableColumns = props.tableColumns;
    const tableAndClusterProps = props;
    const useColumnIds = props.useColumnIds;
    if (event.RequestType === 'Create') {
        const tableName = await createTable(tableNamePrefix, tableNameSuffix, tableColumns, tableAndClusterProps);
        return {
            PhysicalResourceId: (0, util_1.makePhysicalId)(tableName, tableAndClusterProps, event.RequestId),
            Data: { TableName: tableName },
        };
    }
    else if (event.RequestType === 'Delete') {
        try {
            await dropTable(event.PhysicalResourceId, tableAndClusterProps);
        }
        catch {
            await dropTable(tableNamePrefix + tableNameSuffix, tableAndClusterProps);
        }
        return;
    }
    else if (event.RequestType === 'Update') {
        const tableName = await updateTable(event.OldResourceProperties?.Data?.TableName ?? event.PhysicalResourceId, tableNamePrefix, tableNameSuffix, tableColumns, useColumnIds, tableAndClusterProps, event.OldResourceProperties);
        return {
            PhysicalResourceId: event.PhysicalResourceId,
            Data: { TableName: tableName },
        };
    }
    else {
        /* eslint-disable-next-line dot-notation */
        throw new Error(`Unrecognized event type: ${event['RequestType']}`);
    }
}
exports.handler = handler;
async function createTable(tableNamePrefix, tableNameSuffix, tableColumns, tableAndClusterProps) {
    const tableName = tableNamePrefix + tableNameSuffix;
    const tableColumnsString = tableColumns.map(column => `${column.name} ${column.dataType}${getEncodingColumnString(column)}`).join();
    let statement = `CREATE TABLE ${tableName} (${tableColumnsString})`;
    if (tableAndClusterProps.distStyle) {
        statement += ` DISTSTYLE ${tableAndClusterProps.distStyle}`;
    }
    const distKeyColumn = (0, util_1.getDistKeyColumn)(tableColumns);
    if (distKeyColumn) {
        statement += ` DISTKEY(${distKeyColumn.name})`;
    }
    const sortKeyColumns = (0, util_1.getSortKeyColumns)(tableColumns);
    if (sortKeyColumns.length > 0) {
        const sortKeyColumnsString = getSortKeyColumnsString(sortKeyColumns);
        statement += ` ${tableAndClusterProps.sortStyle} SORTKEY(${sortKeyColumnsString})`;
    }
    await (0, redshift_data_1.executeStatement)(statement, tableAndClusterProps);
    for (const column of tableColumns) {
        if (column.comment) {
            await (0, redshift_data_1.executeStatement)(`COMMENT ON COLUMN ${tableName}.${column.name} IS '${column.comment}'`, tableAndClusterProps);
        }
    }
    if (tableAndClusterProps.tableComment) {
        await (0, redshift_data_1.executeStatement)(`COMMENT ON TABLE ${tableName} IS '${tableAndClusterProps.tableComment}'`, tableAndClusterProps);
    }
    return tableName;
}
async function dropTable(tableName, clusterProps) {
    await (0, redshift_data_1.executeStatement)(`DROP TABLE ${tableName}`, clusterProps);
}
async function updateTable(tableName, tableNamePrefix, tableNameSuffix, tableColumns, useColumnIds, tableAndClusterProps, oldResourceProperties) {
    const alterationStatements = [];
    const oldClusterProps = oldResourceProperties;
    if (tableAndClusterProps.clusterName !== oldClusterProps.clusterName || tableAndClusterProps.databaseName !== oldClusterProps.databaseName) {
        return createTable(tableNamePrefix, tableNameSuffix, tableColumns, tableAndClusterProps);
    }
    const oldTableColumns = oldResourceProperties.tableColumns;
    const columnDeletions = oldTableColumns.filter(oldColumn => (tableColumns.every(column => {
        if (useColumnIds) {
            return oldColumn.id ? oldColumn.id !== column.id : oldColumn.name !== column.name;
        }
        return oldColumn.name !== column.name;
    })));
    if (columnDeletions.length > 0) {
        alterationStatements.push(...columnDeletions.map(column => `ALTER TABLE ${tableName} DROP COLUMN ${column.name}`));
    }
    const columnAdditions = tableColumns.filter(column => {
        return !oldTableColumns.some(oldColumn => {
            if (useColumnIds) {
                return oldColumn.id ? oldColumn.id === column.id : oldColumn.name === column.name;
            }
            return oldColumn.name === column.name;
        });
    }).map(column => `ADD ${column.name} ${column.dataType}`);
    if (columnAdditions.length > 0) {
        alterationStatements.push(...columnAdditions.map(addition => `ALTER TABLE ${tableName} ${addition}`));
    }
    const columnEncoding = tableColumns.filter(column => {
        return oldTableColumns.some(oldColumn => column.name === oldColumn.name && column.encoding !== oldColumn.encoding);
    }).map(column => `ALTER COLUMN ${column.name} ENCODE ${column.encoding || 'AUTO'}`);
    if (columnEncoding.length > 0) {
        alterationStatements.push(`ALTER TABLE ${tableName} ${columnEncoding.join(', ')}`);
    }
    const columnComments = tableColumns.filter(column => {
        return oldTableColumns.some(oldColumn => column.name === oldColumn.name && column.comment !== oldColumn.comment);
    }).map(column => `COMMENT ON COLUMN ${tableName}.${column.name} IS ${column.comment ? `'${column.comment}'` : 'NULL'}`);
    if (columnComments.length > 0) {
        alterationStatements.push(...columnComments);
    }
    if (useColumnIds) {
        const columnNameUpdates = tableColumns.reduce((updates, column) => {
            const oldColumn = oldTableColumns.find(oldCol => oldCol.id && oldCol.id === column.id);
            if (oldColumn && oldColumn.name !== column.name) {
                updates[oldColumn.name] = column.name;
            }
            return updates;
        }, {});
        if (Object.keys(columnNameUpdates).length > 0) {
            alterationStatements.push(...Object.entries(columnNameUpdates).map(([oldName, newName]) => (`ALTER TABLE ${tableName} RENAME COLUMN ${oldName} TO ${newName}`)));
        }
    }
    const oldDistStyle = oldResourceProperties.distStyle;
    if ((!oldDistStyle && tableAndClusterProps.distStyle) ||
        (oldDistStyle && !tableAndClusterProps.distStyle)) {
        return createTable(tableNamePrefix, tableNameSuffix, tableColumns, tableAndClusterProps);
    }
    else if (oldDistStyle !== tableAndClusterProps.distStyle) {
        alterationStatements.push(`ALTER TABLE ${tableName} ALTER DISTSTYLE ${tableAndClusterProps.distStyle}`);
    }
    const oldDistKey = (0, util_1.getDistKeyColumn)(oldTableColumns)?.name;
    const newDistKey = (0, util_1.getDistKeyColumn)(tableColumns)?.name;
    if (!oldDistKey && newDistKey) {
        // Table has no existing distribution key, add a new one
        alterationStatements.push(`ALTER TABLE ${tableName} ALTER DISTSTYLE KEY DISTKEY ${newDistKey}`);
    }
    else if (oldDistKey && !newDistKey) {
        // Table has a distribution key, remove and set to AUTO
        alterationStatements.push(`ALTER TABLE ${tableName} ALTER DISTSTYLE AUTO`);
    }
    else if (oldDistKey !== newDistKey) {
        // Table has an existing distribution key, change it
        alterationStatements.push(`ALTER TABLE ${tableName} ALTER DISTKEY ${newDistKey}`);
    }
    const oldSortKeyColumns = (0, util_1.getSortKeyColumns)(oldTableColumns);
    const newSortKeyColumns = (0, util_1.getSortKeyColumns)(tableColumns);
    const oldSortStyle = oldResourceProperties.sortStyle;
    const newSortStyle = tableAndClusterProps.sortStyle;
    if ((oldSortStyle === newSortStyle && !(0, util_1.areColumnsEqual)(oldSortKeyColumns, newSortKeyColumns))
        || (oldSortStyle !== newSortStyle)) {
        switch (newSortStyle) {
            case types_1.TableSortStyle.INTERLEAVED:
                // INTERLEAVED sort key addition requires replacement.
                // https://docs.aws.amazon.com/redshift/latest/dg/r_ALTER_TABLE.html
                return createTable(tableNamePrefix, tableNameSuffix, tableColumns, tableAndClusterProps);
            case types_1.TableSortStyle.COMPOUND: {
                const sortKeyColumnsString = getSortKeyColumnsString(newSortKeyColumns);
                alterationStatements.push(`ALTER TABLE ${tableName} ALTER ${newSortStyle} SORTKEY(${sortKeyColumnsString})`);
                break;
            }
            case types_1.TableSortStyle.AUTO: {
                alterationStatements.push(`ALTER TABLE ${tableName} ALTER SORTKEY ${newSortStyle}`);
                break;
            }
        }
    }
    const oldComment = oldResourceProperties.tableComment;
    const newComment = tableAndClusterProps.tableComment;
    if (oldComment !== newComment) {
        alterationStatements.push(`COMMENT ON TABLE ${tableName} IS ${newComment ? `'${newComment}'` : 'NULL'}`);
    }
    await Promise.all(alterationStatements.map(statement => (0, redshift_data_1.executeStatement)(statement, tableAndClusterProps)));
    const oldTableNamePrefix = oldResourceProperties.tableName.prefix;
    if (tableNamePrefix !== oldTableNamePrefix) {
        await (0, redshift_data_1.executeStatement)(`ALTER TABLE ${tableName} RENAME TO ${tableNamePrefix + tableNameSuffix}`, tableAndClusterProps);
        return tableNamePrefix + tableNameSuffix;
    }
    return tableName;
}
function getSortKeyColumnsString(sortKeyColumns) {
    return sortKeyColumns.map(column => column.name).join();
}
function getEncodingColumnString(column) {
    if (column.encoding) {
        return ` ENCODE ${column.encoding}`;
    }
    return '';
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGFibGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJ0YWJsZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFHQSxtREFBbUQ7QUFDbkQsbUNBQTZFO0FBQzdFLGlDQUE4RjtBQUV2RixLQUFLLFVBQVUsT0FBTyxDQUFDLEtBQTJCLEVBQUUsS0FBa0Q7SUFDM0csTUFBTSxlQUFlLEdBQUcsS0FBSyxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUM7SUFDL0MsTUFBTSxlQUFlLEdBQUcsS0FBSyxDQUFDLFNBQVMsQ0FBQyxjQUFjLEtBQUssTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxHQUFHLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUNqSSxNQUFNLFlBQVksR0FBRyxLQUFLLENBQUMsWUFBWSxDQUFDO0lBQ3hDLE1BQU0sb0JBQW9CLEdBQUcsS0FBSyxDQUFDO0lBQ25DLE1BQU0sWUFBWSxHQUFHLEtBQUssQ0FBQyxZQUFZLENBQUM7SUFFeEMsSUFBSSxLQUFLLENBQUMsV0FBVyxLQUFLLFFBQVEsRUFBRTtRQUNsQyxNQUFNLFNBQVMsR0FBRyxNQUFNLFdBQVcsQ0FBQyxlQUFlLEVBQUUsZUFBZSxFQUFFLFlBQVksRUFBRSxvQkFBb0IsQ0FBQyxDQUFDO1FBQzFHLE9BQU87WUFDTCxrQkFBa0IsRUFBRSxJQUFBLHFCQUFjLEVBQUMsU0FBUyxFQUFFLG9CQUFvQixFQUFFLEtBQUssQ0FBQyxTQUFTLENBQUM7WUFDcEYsSUFBSSxFQUFFLEVBQUUsU0FBUyxFQUFFLFNBQVMsRUFBRTtTQUMvQixDQUFDO0tBQ0g7U0FBTSxJQUFJLEtBQUssQ0FBQyxXQUFXLEtBQUssUUFBUSxFQUFFO1FBQ3pDLElBQUk7WUFDRixNQUFNLFNBQVMsQ0FBQyxLQUFLLENBQUMsa0JBQWtCLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztTQUNq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QUMsTUFBYztJQUM3QyxJQUFJLE1BQU0sQ0FBQyxRQUFRLEVBQUU7UUFDbkIsT0FBTyxXQUFXLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQztLQUNyQztJQUNELE9BQU8sRUFBRSxDQUFDO0FBQ1osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBpbXBvcnQvbm8tdW5yZXNvbHZlZCAqL1xuaW1wb3J0ICogYXMgQVdTTGFtYmRhIGZyb20gJ2F3cy1sYW1iZGEnO1xuaW1wb3J0IHsgQ29sdW1uIH0gZnJvbSAnLi4vLi4vdGFibGUnO1xuaW1wb3J0IHsgZXhlY3V0ZVN0YXRlbWVudCB9IGZyb20gJy4vcmVkc2hpZnQtZGF0YSc7XG5pbXBvcnQgeyBDbHVzdGVyUHJvcHMsIFRhYmxlQW5kQ2x1c3RlclByb3BzLCBUYWJsZVNvcnRTdHlsZSB9IGZyb20gJy4vdHlwZXMnO1xuaW1wb3J0IHsgYXJlQ29sdW1uc0VxdWFsLCBnZXREaXN0S2V5Q29sdW1uLCBnZXRTb3J0S2V5Q29sdW1ucywgbWFrZVBoeXNpY2FsSWQgfSBmcm9tICcuL3V0aWwnO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlcihwcm9wczogVGFibGVBbmRDbHVzdGVyUHJvcHMsIGV2ZW50OiBBV1NMYW1iZGEuQ2xvdWRGb3JtYXRpb25DdXN0b21SZXNvdXJjZUV2ZW50KSB7XG4gIGNvbnN0IHRhYmxlTmFtZVByZWZpeCA9IHByb3BzLnRhYmxlTmFtZS5wcmVmaXg7XG4gIGNvbnN0IHRhYmxlTmFtZVN1ZmZpeCA9IHByb3BzLnRhYmxlTmFtZS5nZW5lcmF0ZVN1ZmZpeCA9PT0gJ3RydWUnID8gYCR7ZXZlbnQuU3RhY2tJZC5zdWJzdHJpbmcoZXZlbnQuU3RhY2tJZC5sZW5ndGggLSAxMil9YCA6ICcnO1xuICBjb25zdCB0YWJsZUNvbHVtbnMgPSBwcm9wcy50YWJsZUNvbHVtbnM7XG4gIGNvbnN0IHRhYmxlQW5kQ2x1c3RlclByb3BzID0gcHJvcHM7XG4gIGNvbnN0IHVzZUNvbHVtbklkcyA9IHByb3BzLnVzZUNvbHVtbklkcztcblxuICBpZiAoZXZlbnQuUmVxdWVzdFR5cGUgPT09ICdDcmVhdGUnKSB7XG4gICAgY29uc3QgdGFibGVOYW1lID0gYXdhaXQgY3JlYXRlVGFibGUodGFibGVOYW1lUHJlZml4LCB0YWJsZU5hbWVTdWZmaXgsIHRhYmxlQ29sdW1ucywgdGFibGVBbmRDbHVzdGVyUHJvcHMpO1xuICAgIHJldHVybiB7XG4gICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IG1ha2VQaHlzaWNhbElkKHRhYmxlTmFtZSwgdGFibGVBbmRDbHVzdGVyUHJvcHMsIGV2ZW50LlJlcXVlc3RJZCksXG4gICAgICBEYXRhOiB7IFRhYmxlTmFtZTogdGFibGVOYW1lIH0sXG4gICAgfTtcbiAgfSBlbHNlIGlmIChldmVudC5SZXF1ZXN0VHlwZSA9PT0gJ0RlbGV0ZScpIHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZHJvcFRhYmxlKGV2ZW50LlBoeXNpY2FsUmVzb3VyY2VJZCwgdGFibGVBbmRDbHVzdGVyUHJvcHMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgYXdhaXQgZHJvcFRhYmxlKHRhYmxlTmFtZVByZWZpeCArIHRhYmxlTmFtZVN1ZmZpeCwgdGFibGVBbmRDbHVzdGVyUHJvcHMpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH0gZWxzZSBpZiAoZXZlbnQuUmVxdWVzdFR5cGUgPT09ICdVcGRhdGUnKSB7XG4gICAgY29uc3QgdGFibGVOYW1lID0gYXdhaXQgdXBkYXRlVGFibGUoXG4gICAgICBldmVudC5PbGRSZXNvdXJjZVByb3BlcnRpZXM/LkRhdGE/LlRhYmxlTmFtZSA/PyBldmVudC5QaHlzaWNhbFJlc291cmNlSWQsXG4gICAgICB0YWJsZU5hbWVQcmVmaXgsXG4gICAgICB0YWJsZU5hbWVTdWZmaXgsXG4gICAgICB0YWJsZUNvbHVtbnMsXG4gICAgICB1c2VDb2x1bW5JZHMsXG4gICAgICB0YWJsZUFuZENsdXN0ZXJQcm9wcyxcbiAgICAgIGV2ZW50Lk9sZFJlc291cmNlUHJvcGVydGllcyBhcyBUYWJsZUFuZENsdXN0ZXJQcm9wcyxcbiAgICApO1xuICAgIHJldHVybiB7XG4gICAgICBQaHlzaWNhbFJlc291cmNlSWQ6IGV2ZW50LlBoeXNpY2FsUmVzb3VyY2VJZCxcbiAgICAgIERhdGE6IHsgVGFibGVOYW1lOiB0YWJsZU5hbWUgfSxcbiAgICB9O1xuICB9IGVsc2Uge1xuICAgIC8qIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBkb3Qtbm90YXRpb24gKi9cbiAgICB0aHJvdyBuZXcgRXJyb3IoYFVucmVjb2duaXplZCBldmVudCB0eXBlOiAke2V2ZW50WydSZXF1ZXN0VHlwZSddfWApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNyZWF0ZVRhYmxlKFxuICB0YWJsZU5hbWVQcmVmaXg6IHN0cmluZyxcbiAgdGFibGVOYW1lU3VmZml4OiBzdHJpbmcsXG4gIHRhYmxlQ29sdW1uczogQ29sdW1uW10sXG4gIHRhYmxlQW5kQ2x1c3RlclByb3BzOiBUYWJsZUFuZENsdXN0ZXJQcm9wcyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHRhYmxlTmFtZVByZWZpeCArIHRhYmxlTmFtZVN1ZmZpeDtcbiAgY29uc3QgdGFibGVDb2x1bW5zU3RyaW5nID0gdGFibGVDb2x1bW5zLm1hcChjb2x1bW4gPT4gYCR7Y29sdW1uLm5hbWV9ICR7Y29sdW1uLmRhdGFUeXBlfSR7Z2V0RW5jb2RpbmdDb2x1bW5TdHJpbmcoY29sdW1uKX1gKS5qb2luKCk7XG5cbiAgbGV0IHN0YXRlbWVudCA9IGBDUkVBVEUgVEFCTEUgJHt0YWJsZU5hbWV9ICgke3RhYmxlQ29sdW1uc1N0cmluZ30pYDtcblxuICBpZiAodGFibGVBbmRDbHVzdGVyUHJvcHMuZGlzdFN0eWxlKSB7XG4gICAgc3RhdGVtZW50ICs9IGAgRElTVFNUWUxFICR7dGFibGVBbmRDbHVzdGVyUHJvcHMuZGlzdFN0eWxlfWA7XG4gIH1cblxuICBjb25zdCBkaXN0S2V5Q29sdW1uID0gZ2V0RGlzdEtleUNvbHVtbih0YWJsZUNvbHVtbnMpO1xuICBpZiAoZGlzdEtleUNvbHVtbikge1xuICAgIHN0YXRlbWVudCArPSBgIERJU1RLRVkoJHtkaXN0S2V5Q29sdW1uLm5hbWV9KWA7XG4gIH1cblxuICBjb25zdCBzb3J0S2V5Q29sdW1ucyA9IGdldFNvcnRLZXlDb2x1bW5zKHRhYmxlQ29sdW1ucyk7XG4gIGlmIChzb3J0S2V5Q29sdW1ucy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3Qgc29ydEtleUNvbHVtbnNTdHJpbmcgPSBnZXRTb3J0S2V5Q29sdW1uc1N0cmluZyhzb3J0S2V5Q29sdW1ucyk7XG4gICAgc3RhdGVtZW50ICs9IGAgJHt0YWJsZUFuZENsdXN0ZXJQcm9wcy5zb3J0U3R5bGV9IFNPUlRLRVkoJHtzb3J0S2V5Q29sdW1uc1N0cmluZ30pYDtcbiAgfVxuXG4gIGF3YWl0IGV4ZWN1dGVTdGF0ZW1lbnQoc3RhdGVtZW50LCB0YWJsZUFuZENsdXN0ZXJQcm9wcyk7XG5cbiAgZm9yIChjb25zdCBjb2x1bW4gb2YgdGFibGVDb2x1bW5zKSB7XG4gICAgaWYgKGNvbHVtbi5jb21tZW50KSB7XG4gICAgICBhd2FpdCBleGVjdXRlU3RhdGVtZW50KGBDT01NRU5UIE9OIENPTFVNTiAke3RhYmxlTmFtZX0uJHtjb2x1bW4ubmFtZX0gSVMgJyR7Y29sdW1uLmNvbW1lbnR9J2AsIHRhYmxlQW5kQ2x1c3RlclByb3BzKTtcbiAgICB9XG4gIH1cbiAgaWYgKHRhYmxlQW5kQ2x1c3RlclByb3BzLnRhYmxlQ29tbWVudCkge1xuICAgIGF3YWl0IGV4ZWN1dGVTdGF0ZW1lbnQoYENPTU1FTlQgT04gVEFCTEUgJHt0YWJsZU5hbWV9IElTICcke3RhYmxlQW5kQ2x1c3RlclByb3BzLnRhYmxlQ29tbWVudH0nYCwgdGFibGVBbmRDbHVzdGVyUHJvcHMpO1xuICB9XG5cbiAgcmV0dXJuIHRhYmxlTmFtZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZHJvcFRhYmxlKHRhYmxlTmFtZTogc3RyaW5nLCBjbHVzdGVyUHJvcHM6IENsdXN0ZXJQcm9wcykge1xuICBhd2FpdCBleGVjdXRlU3RhdGVtZW50KGBEUk9QIFRBQkxFICR7dGFibGVOYW1lfWAsIGNsdXN0ZXJQcm9wcyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZVRhYmxlKFxuICB0YWJsZU5hbWU6IHN0cmluZyxcbiAgdGFibGVOYW1lUHJlZml4OiBzdHJpbmcsXG4gIHRhYmxlTmFtZVN1ZmZpeDogc3RyaW5nLFxuICB0YWJsZUNvbHVtbnM6IENvbHVtbltdLFxuICB1c2VDb2x1bW5JZHM6IGJvb2xlYW4sXG4gIHRhYmxlQW5kQ2x1c3RlclByb3BzOiBUYWJsZUFuZENsdXN0ZXJQcm9wcyxcbiAgb2xkUmVzb3VyY2VQcm9wZXJ0aWVzOiBUYWJsZUFuZENsdXN0ZXJQcm9wcyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGFsdGVyYXRpb25TdGF0ZW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGNvbnN0IG9sZENsdXN0ZXJQcm9wcyA9IG9sZFJlc291cmNlUHJvcGVydGllcztcbiAgaWYgKHRhYmxlQW5kQ2x1c3RlclByb3BzLmNsdXN0ZXJOYW1lICE9PSBvbGRDbHVzdGVyUHJvcHMuY2x1c3Rlck5hbWUgfHwgdGFibGVBbmRDbHVzdGVyUHJvcHMuZGF0YWJhc2VOYW1lICE9PSBvbGRDbHVzdGVyUHJvcHMuZGF0YWJhc2VOYW1lKSB7XG4gICAgcmV0dXJuIGNyZWF0ZVRhYmxlKHRhYmxlTmFtZVByZWZpeCwgdGFibGVOYW1lU3VmZml4LCB0YWJsZUNvbHVtbnMsIHRhYmxlQW5kQ2x1c3RlclByb3BzKTtcbiAgfVxuXG4gIGNvbnN0IG9sZFRhYmxlQ29sdW1ucyA9IG9sZFJlc291cmNlUHJvcGVydGllcy50YWJsZUNvbHVtbnM7XG4gIGNvbnN0IGNvbHVtbkRlbGV0aW9ucyA9IG9sZFRhYmxlQ29sdW1ucy5maWx0ZXIob2xkQ29sdW1uID0+IChcbiAgICB0YWJsZUNvbHVtbnMuZXZlcnkoY29sdW1uID0+IHtcbiAgICAgIGlmICh1c2VDb2x1bW5JZHMpIHtcbiAgICAgICAgcmV0dXJuIG9sZENvbHVtbi5pZCA/IG9sZENvbHVtbi5pZCAhPT0gY29sdW1uLmlkIDogb2xkQ29sdW1uLm5hbWUgIT09IGNvbHVtbi5uYW1lO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG9sZENvbHVtbi5uYW1lICE9PSBjb2x1bW4ubmFtZTtcbiAgICB9KVxuICApKTtcbiAgaWYgKGNvbHVtbkRlbGV0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgYWx0ZXJhdGlvblN0YXRlbWVudHMucHVzaCguLi5jb2x1bW5EZWxldGlvbnMubWFwKGNvbHVtbiA9PiBgQUxURVIgVEFCTEUgJHt0YWJsZU5hbWV9IERST1AgQ09MVU1OICR7Y29sdW1uLm5hbWV9YCkpO1xuICB9XG5cbiAgY29uc3QgY29sdW1uQWRkaXRpb25zID0gdGFibGVDb2x1bW5zLmZpbHRlcihjb2x1bW4gPT4ge1xuICAgIHJldHVybiAhb2xkVGFibGVDb2x1bW5zLnNvbWUob2xkQ29sdW1uID0+IHtcbiAgICAgIGlmICh1c2VDb2x1bW5JZHMpIHtcbiAgICAgICAgcmV0dXJuIG9sZENvbHVtbi5pZCA/IG9sZENvbHVtbi5pZCA9PT0gY29sdW1uLmlkIDogb2xkQ29sdW1uLm5hbWUgPT09IGNvbHVtbi5uYW1lO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG9sZENvbHVtbi5uYW1lID09PSBjb2x1bW4ubmFtZTtcbiAgICB9KTtcbiAgfSkubWFwKGNvbHVtbiA9PiBgQUREICR7Y29sdW1uLm5hbWV9ICR7Y29sdW1uLmRhdGFUeXBlfWApO1xuICBpZiAoY29sdW1uQWRkaXRpb25zLmxlbmd0aCA+IDApIHtcbiAgICBhbHRlcmF0aW9uU3RhdGVtZW50cy5wdXNoKC4uLmNvbHVtbkFkZGl0aW9ucy5tYXAoYWRkaXRpb24gPT4gYEFMVEVSIFRBQkxFICR7dGFibGVOYW1lfSAke2FkZGl0aW9ufWApKTtcbiAgfVxuXG4gIGNvbnN0IGNvbHVtbkVuY29kaW5nID0gdGFibGVDb2x1bW5zLmZpbHRlcihjb2x1bW4gPT4ge1xuICAgIHJldHVybiBvbGRUYWJsZUNvbHVtbnMuc29tZShvbGRDb2x1bW4gPT4gY29sdW1uLm5hbWUgPT09IG9sZENvbHVtbi5uYW1lICYmIGNvbHVtbi5lbmNvZGluZyAhPT0gb2xkQ29sdW1uLmVuY29kaW5nKTtcbiAgfSkubWFwKGNvbHVtbiA9PiBgQUxURVIgQ09MVU1OICR7Y29sdW1uLm5hbWV9IEVOQ09ERSAke2NvbHVtbi5lbmNvZGluZyB8fCAnQVVUTyd9YCk7XG4gIGlmIChjb2x1bW5FbmNvZGluZy5sZW5ndGggPiAwKSB7XG4gICAgYWx0ZXJhdGlvblN0YXRlbWVudHMucHVzaChgQUxURVIgVEFCTEUgJHt0YWJsZU5hbWV9ICR7Y29sdW1uRW5jb2Rpbmcuam9pbignLCAnKX1gKTtcbiAgfVxuXG4gIGNvbnN0IGNvbHVtbkNvbW1lbnRzID0gdGFibGVDb2x1bW5zLmZpbHRlcihjb2x1bW4gPT4ge1xuICAgIHJldHVybiBvbGRUYWJsZUNvbHVtbnMuc29tZShvbGRDb2x1bW4gPT4gY29sdW1uLm5hbWUgPT09IG9sZENvbHVtbi5uYW1lICYmIGNvbHVtbi5jb21tZW50ICE9PSBvbGRDb2x1bW4uY29tbWVudCk7XG4gIH0pLm1hcChjb2x1bW4gPT4gYENPTU1FTlQgT04gQ09MVU1OICR7dGFibGVOYW1lfS4ke2NvbHVtbi5uYW1lfSBJUyAke2NvbHVtbi5jb21tZW50ID8gYCcke2NvbHVtbi5jb21tZW50fSdgIDogJ05VTEwnfWApO1xuICBpZiAoY29sdW1uQ29tbWVudHMubGVuZ3RoID4gMCkge1xuICAgIGFsdGVyYXRpb25TdGF0ZW1lbnRzLnB1c2goLi4uY29sdW1uQ29tbWVudHMpO1xuICB9XG5cbiAgaWYgKHVzZUNvbHVtbklkcykge1xuICAgIGNvbnN0IGNvbHVtbk5hbWVVcGRhdGVzID0gdGFibGVDb2x1bW5zLnJlZHVjZSgodXBkYXRlcywgY29sdW1uKSA9PiB7XG4gICAgICBjb25zdCBvbGRDb2x1bW4gPSBvbGRUYWJsZUNvbHVtbnMuZmluZChvbGRDb2wgPT4gb2xkQ29sLmlkICYmIG9sZENvbC5pZCA9PT0gY29sdW1uLmlkKTtcbiAgICAgIGlmIChvbGRDb2x1bW4gJiYgb2xkQ29sdW1uLm5hbWUgIT09IGNvbHVtbi5uYW1lKSB7XG4gICAgICAgIHVwZGF0ZXNbb2xkQ29sdW1uLm5hbWVdID0gY29sdW1uLm5hbWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gdXBkYXRlcztcbiAgICB9LCB7fSBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KTtcbiAgICBpZiAoT2JqZWN0LmtleXMoY29sdW1uTmFtZVVwZGF0ZXMpLmxlbmd0aCA+IDApIHtcbiAgICAgIGFsdGVyYXRpb25TdGF0ZW1lbnRzLnB1c2goLi4uT2JqZWN0LmVudHJpZXMoY29sdW1uTmFtZVVwZGF0ZXMpLm1hcCgoW29sZE5hbWUsIG5ld05hbWVdKSA9PiAoXG4gICAgICAgIGBBTFRFUiBUQUJMRSAke3RhYmxlTmFtZX0gUkVOQU1FIENPTFVNTiAke29sZE5hbWV9IFRPICR7bmV3TmFtZX1gXG4gICAgICApKSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3Qgb2xkRGlzdFN0eWxlID0gb2xkUmVzb3VyY2VQcm9wZXJ0aWVzLmRpc3RTdHlsZTtcbiAgaWYgKCghb2xkRGlzdFN0eWxlICYmIHRhYmxlQW5kQ2x1c3RlclByb3BzLmRpc3RTdHlsZSkgfHxcbiAgICAob2xkRGlzdFN0eWxlICYmICF0YWJsZUFuZENsdXN0ZXJQcm9wcy5kaXN0U3R5bGUpKSB7XG4gICAgcmV0dXJuIGNyZWF0ZVRhYmxlKHRhYmxlTmFtZVByZWZpeCwgdGFibGVOYW1lU3VmZml4LCB0YWJsZUNvbHVtbnMsIHRhYmxlQW5kQ2x1c3RlclByb3BzKTtcbiAgfSBlbHNlIGlmIChvbGREaXN0U3R5bGUgIT09IHRhYmxlQW5kQ2x1c3RlclByb3BzLmRpc3RTdHlsZSkge1xuICAgIGFsdGVyYXRpb25TdGF0ZW1lbnRzLnB1c2goYEFMVEVSIFRBQkxFICR7dGFibGVOYW1lfSBBTFRFUiBESVNUU1RZTEUgJHt0YWJsZUFuZENsdXN0ZXJQcm9wcy5kaXN0U3R5bGV9YCk7XG4gIH1cblxuICBjb25zdCBvbGREaXN0S2V5ID0gZ2V0RGlzdEtleUNvbHVtbihvbGRUYWJsZUNvbHVtbnMpPy5uYW1lO1xuICBjb25zdCBuZXdEaXN0S2V5ID0gZ2V0RGlzdEtleUNvbHVtbih0YWJsZUNvbHVtbnMpPy5uYW1lO1xuICBpZiAoIW9sZERpc3RLZXkgJiYgbmV3RGlzdEtleSkge1xuICAgIC8vIFRhYmxlIGhhcyBubyBleGlzdGluZyBkaXN0cmlidXRpb24ga2V5LCBhZGQgYSBuZXcgb25lXG4gICAgYWx0ZXJhdGlvblN0YXRlbWVudHMucHVzaChgQUxURVIgVEFCTEUgJHt0YWJsZU5hbWV9IEFMVEVSIERJU1RTVFlMRSBLRVkgRElTVEtFWSAke25ld0Rpc3RLZXl9YCk7XG4gIH0gZWxzZSBpZiAob2xkRGlzdEtleSAmJiAhbmV3RGlzdEtleSkge1xuICAgIC8vIFRhYmxlIGhhcyBhIGRpc3RyaWJ1dGlvbiBrZXksIHJlbW92ZSBhbmQgc2V0IHRvIEFVVE9cbiAgICBhbHRlcmF0aW9uU3RhdGVtZW50cy5wdXNoKGBBTFRFUiBUQUJMRSAke3RhYmxlTmFtZX0gQUxURVIgRElTVFNUWUxFIEFVVE9gKTtcbiAgfSBlbHNlIGlmIChvbGREaXN0S2V5ICE9PSBuZXdEaXN0S2V5KSB7XG4gICAgLy8gVGFibGUgaGFzIGFuIGV4aXN0aW5nIGRpc3RyaWJ1dGlvbiBrZXksIGNoYW5nZSBpdFxuICAgIGFsdGVyYXRpb25TdGF0ZW1lbnRzLnB1c2goYEFMVEVSIFRBQkxFICR7dGFibGVOYW1lfSBBTFRFUiBESVNUS0VZICR7bmV3RGlzdEtleX1gKTtcbiAgfVxuXG4gIGNvbnN0IG9sZFNvcnRLZXlDb2x1bW5zID0gZ2V0U29ydEtleUNvbHVtbnMob2xkVGFibGVDb2x1bW5zKTtcbiAgY29uc3QgbmV3U29ydEtleUNvbHVtbnMgPSBnZXRTb3J0S2V5Q29sdW1ucyh0YWJsZUNvbHVtbnMpO1xuICBjb25zdCBvbGRTb3J0U3R5bGUgPSBvbGRSZXNvdXJjZVByb3BlcnRpZXMuc29ydFN0eWxlO1xuICBjb25zdCBuZXdTb3J0U3R5bGUgPSB0YWJsZUFuZENsdXN0ZXJQcm9wcy5zb3J0U3R5bGU7XG4gIGlmICgob2xkU29ydFN0eWxlID09PSBuZXdTb3J0U3R5bGUgJiYgIWFyZUNvbHVtbnNFcXVhbChvbGRTb3J0S2V5Q29sdW1ucywgbmV3U29ydEtleUNvbHVtbnMpKVxuICAgIHx8IChvbGRTb3J0U3R5bGUgIT09IG5ld1NvcnRTdHlsZSkpIHtcbiAgICBzd2l0Y2ggKG5ld1NvcnRTdHlsZSkge1xuICAgICAgY2FzZSBUYWJsZVNvcnRTdHlsZS5JTlRFUkxFQVZFRDpcbiAgICAgICAgLy8gSU5URVJMRUFWRUQgc29ydCBrZXkgYWRkaXRpb24gcmVxdWlyZXMgcmVwbGFjZW1lbnQuXG4gICAgICAgIC8vIGh0dHBzOi8vZG9jcy5hd3MuYW1hem9uLmNvbS9yZWRzaGlmdC9sYXRlc3QvZGcvcl9BTFRFUl9UQUJMRS5odG1sXG4gICAgICAgIHJldHVybiBjcmVhdGVUYWJsZSh0YWJsZU5hbWVQcmVmaXgsIHRhYmxlTmFtZVN1ZmZpeCwgdGFibGVDb2x1bW5zLCB0YWJsZUFuZENsdXN0ZXJQcm9wcyk7XG5cbiAgICAgIGNhc2UgVGFibGVTb3J0U3R5bGUuQ09NUE9VTkQ6IHtcbiAgICAgICAgY29uc3Qgc29ydEtleUNvbHVtbnNTdHJpbmcgPSBnZXRTb3J0S2V5Q29sdW1uc1N0cmluZyhuZXdTb3J0S2V5Q29sdW1ucyk7XG4gICAgICAgIGFsdGVyYXRpb25TdGF0ZW1lbnRzLnB1c2goYEFMVEVSIFRBQkxFICR7dGFibGVOYW1lfSBBTFRFUiAke25ld1NvcnRTdHlsZX0gU09SVEtFWSgke3NvcnRLZXlDb2x1bW5zU3RyaW5nfSlgKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgVGFibGVTb3J0U3R5bGUuQVVUTzoge1xuICAgICAgICBhbHRlcmF0aW9uU3RhdGVtZW50cy5wdXNoKGBBTFRFUiBUQUJMRSAke3RhYmxlTmFtZX0gQUxURVIgU09SVEtFWSAke25ld1NvcnRTdHlsZX1gKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgY29uc3Qgb2xkQ29tbWVudCA9IG9sZFJlc291cmNlUHJvcGVydGllcy50YWJsZUNvbW1lbnQ7XG4gIGNvbnN0IG5ld0NvbW1lbnQgPSB0YWJsZUFuZENsdXN0ZXJQcm9wcy50YWJsZUNvbW1lbnQ7XG4gIGlmIChvbGRDb21tZW50ICE9PSBuZXdDb21tZW50KSB7XG4gICAgYWx0ZXJhdGlvblN0YXRlbWVudHMucHVzaChgQ09NTUVOVCBPTiBUQUJMRSAke3RhYmxlTmFtZX0gSVMgJHtuZXdDb21tZW50ID8gYCcke25ld0NvbW1lbnR9J2AgOiAnTlVMTCd9YCk7XG4gIH1cblxuICBhd2FpdCBQcm9taXNlLmFsbChhbHRlcmF0aW9uU3RhdGVtZW50cy5tYXAoc3RhdGVtZW50ID0+IGV4ZWN1dGVTdGF0ZW1lbnQoc3RhdGVtZW50LCB0YWJsZUFuZENsdXN0ZXJQcm9wcykpKTtcblxuICBjb25zdCBvbGRUYWJsZU5hbWVQcmVmaXggPSBvbGRSZXNvdXJjZVByb3BlcnRpZXMudGFibGVOYW1lLnByZWZpeDtcbiAgaWYgKHRhYmxlTmFtZVByZWZpeCAhPT0gb2xkVGFibGVOYW1lUHJlZml4KSB7XG4gICAgYXdhaXQgZXhlY3V0ZVN0YXRlbWVudChgQUxURVIgVEFCTEUgJHt0YWJsZU5hbWV9IFJFTkFNRSBUTyAke3RhYmxlTmFtZVByZWZpeCArIHRhYmxlTmFtZVN1ZmZpeH1gLCB0YWJsZUFuZENsdXN0ZXJQcm9wcyk7XG4gICAgcmV0dXJuIHRhYmxlTmFtZVByZWZpeCArIHRhYmxlTmFtZVN1ZmZpeDtcbiAgfVxuXG4gIHJldHVybiB0YWJsZU5hbWU7XG59XG5cbmZ1bmN0aW9uIGdldFNvcnRLZXlDb2x1bW5zU3RyaW5nKHNvcnRLZXlDb2x1bW5zOiBDb2x1bW5bXSkge1xuICByZXR1cm4gc29ydEtleUNvbHVtbnMubWFwKGNvbHVtbiA9PiBjb2x1bW4ubmFtZSkuam9pbigpO1xufVxuXG5mdW5jdGlvbiBnZXRFbmNvZGluZ0NvbHVtblN0cmluZyhjb2x1bW46IENvbHVtbik6IHN0cmluZyB7XG4gIGlmIChjb2x1bW4uZW5jb2RpbmcpIHtcbiAgICByZXR1cm4gYCBFTkNPREUgJHtjb2x1bW4uZW5jb2Rpbmd9YDtcbiAgfVxuICByZXR1cm4gJyc7XG59XG4iXX0=