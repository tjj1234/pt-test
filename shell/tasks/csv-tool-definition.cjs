'use strict';

const { PERMISSIONS } = require('../permissions/index.cjs');

function csvAnalyzeToolDefinition() {
  return {
    name: 'csv.analyze', type: 'workflow', version: '1.0.0',
    description: '对当前 Run 的 CSV 附件按明确列和数据起始行做确定性数值计算，并返回原始行列证据。',
    inputSchema: {
      type: 'object',
      required: ['sourceRef', 'sourceSha256', 'operation', 'column', 'startRow'],
      properties: {
        sourceRef: { type: 'string' },
        sourceSha256: { type: 'string' },
        operation: { type: 'string', enum: ['sum', 'count', 'min', 'max'] },
        column: { type: 'integer' },
        outputFormat: { type:'string', enum:['csv','xlsx'] },
        startRow: { type: 'integer' },
      },
      additionalProperties: false,
    },
    outputType: 'data', riskLevel: 'read', requiredPermissions: [PERMISSIONS.TOOL_USE],
  };
}

module.exports = { csvAnalyzeToolDefinition };
