/**
 * 다이어그램 테마 매핑 테스트 — 3개 테마 × 4개 다이어그램 타입
 * Usage: node tools/test-diagram-themes.js
 */
const fs = require('fs');
const path = require('path');
const { RENDERERS, buildMermaidConfig } = require('../lib/diagram-renderer');

const renderer = RENDERERS.mermaid;
if (!renderer.isAvailable()) {
  console.error('mmdc not found');
  process.exit(1);
}

const themes = ['navy-professional', 'teal-corporate', 'wine-elegant'];

const diagrams = {
  sequence: [
    'sequenceDiagram',
    '    participant C as Client',
    '    participant A as API Server',
    '    participant D as Database',
    '    C->>A: POST /orders',
    '    activate A',
    '    A->>D: INSERT order',
    '    activate D',
    '    D-->>A: order_id',
    '    deactivate D',
    '    Note over A: Validate data',
    '    A-->>C: 201 Created',
    '    deactivate A',
  ].join('\n'),

  flowchart: [
    'flowchart TD',
    '    A[Start] --> B{Check}',
    '    B -->|Yes| C[Process]',
    '    B -->|No| D[Reject]',
    '    C --> E[Validate]',
    '    E --> F{OK?}',
    '    F -->|Yes| G[Complete]',
    '    F -->|No| D',
    '    D --> H[Notify]',
  ].join('\n'),

  er: [
    'erDiagram',
    '    CUSTOMER ||--o{ ORDER : places',
    '    CUSTOMER { int id PK string name string email }',
    '    ORDER ||--|{ ITEM : contains',
    '    ORDER { int id PK date order_date string status }',
    '    ITEM }|--|| PRODUCT : references',
    '    ITEM { int id PK int qty decimal price }',
    '    PRODUCT { int id PK string name decimal price }',
  ].join('\n'),

  pie: [
    'pie title Resource Usage',
    '    "API" : 35',
    '    "Database" : 25',
    '    "Cache" : 20',
    '    "Queue" : 12',
    '    "Other" : 8',
  ].join('\n'),
};

const outDir = path.join(__dirname, '..', 'output', '.diagram-theme-test');
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  console.log('Rendering 3 themes x 4 diagram types = 12 images\n');

  for (const themeName of themes) {
    const themeConfig = require('../themes/' + themeName + '.json');
    const config = buildMermaidConfig(themeConfig);
    const shortName = themeName.split('-')[0];

    console.log(`[${themeName}] primaryBorder=${config.themeVariables.primaryBorderColor} actorBkg=${config.themeVariables.actorBkg}`);

    for (const [type, code] of Object.entries(diagrams)) {
      const outPath = path.join(outDir, shortName + '_' + type + '.png');
      try {
        await renderer.render(code, outPath, {
          width: 1024,
          scale: 2,
          backgroundColor: 'white',
          themeConfig: themeConfig,
        });
        const size = fs.statSync(outPath).size;
        console.log('  OK  ' + shortName + '_' + type + '.png (' + Math.round(size / 1024) + 'KB)');
      } catch (err) {
        console.log('  FAIL ' + shortName + '_' + type + ': ' + err.message.substring(0, 100));
      }
    }
    console.log();
  }

  // 테마 없이 (fallback) 테스트
  console.log('[no-theme] fallback to -t default');
  for (const [type, code] of Object.entries(diagrams)) {
    const outPath = path.join(outDir, 'notheme_' + type + '.png');
    try {
      await renderer.render(code, outPath, {
        width: 1024,
        scale: 2,
        backgroundColor: 'white',
        theme: 'default',
        themeConfig: null,
      });
      const size = fs.statSync(outPath).size;
      console.log('  OK  notheme_' + type + '.png (' + Math.round(size / 1024) + 'KB)');
    } catch (err) {
      console.log('  FAIL notheme_' + type + ': ' + err.message.substring(0, 100));
    }
  }

  console.log('\nDone! ' + fs.readdirSync(outDir).filter(f => f.endsWith('.png')).length + ' images in output/.diagram-theme-test/');
})();
