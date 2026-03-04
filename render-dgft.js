const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const gendocsRoot = __dirname;
const { svgToPng, _recolorSequenceParticipants, _extractSequenceParticipants, buildMermaidConfig } = require(path.join(gendocsRoot, 'lib/diagram-renderer'));

const themeConfig = {
  colors: {
    primary: "1B3664",
    secondary: "2B5598",
    accent: "F5A623",
    text: "333333",
    textLight: "666666",
    white: "FFFFFF",
  }
};

const diagrams = [
  {
    name: 'dgft-approval-flow',
    mermaid: `sequenceDiagram
    participant DGFT as DGFT(가맹점)
    participant QB as 큐뱅
    participant PS as 페이스토리
    participant ACQ as 매입사

    DGFT->>QB: 1. 결제창 진입 및 국내카드 선택
    QB->>PS: 2. 주문정보 전달(returnNoti 포함)
    PS->>ACQ: 3. 결제창 호출(Redirect) + 원화금액환산 + 인증요청
    ACQ-->>ACQ: 4. 카드사 인증수행
    ACQ-->>PS: 5. (인증응답) returnUrl로 Post
    QB->>PS: 6. 승인 요청
    PS->>ACQ: 7. 승인 요청
    PS-->>QB: 8. 승인 응답
    QB-->>DGFT: 9. 승인 응답(returnNoti응답)

    Note right of ACQ: 1. API가이드는 큐뱅 제공분만 확인
    Note right of ACQ: 2. 엔화→원화 환산(큐뱅 markup, 전일 매매기준율)
    Note right of ACQ: 3. 가맹점 MID = DGFT MID 채번(merchant key)
    Note right of ACQ: 4. 승인요청 무응답 시 망취소 구현`
  },
  {
    name: 'dgft-settlement-flow',
    mermaid: `sequenceDiagram
    participant DGFT as DGFT(가맹점)
    participant QB as 큐뱅
    participant PS as 페이스토리
    participant ACQ as 매입사

    ACQ->>PS: 1. 원화 대금지급(T+3)
    PS->>QB: 2. 엔화 대금지급(T+n, 원화→엔화 환전)

    Note over DGFT,QB: CS건 처리
    DGFT->>QB: 3. CS건 접수
    QB->>PS: 큐뱅 담당자 확인 후 취소 요청`
  }
];

async function render() {
  const outDir = path.join(gendocsRoot, 'output');

  for (const d of diagrams) {
    console.log(`Rendering: ${d.name}...`);

    const mermaidConfig = buildMermaidConfig(themeConfig);
    const configPath = path.join(outDir, `${d.name}-config.json`);
    fs.writeFileSync(configPath, JSON.stringify(mermaidConfig, null, 2));

    const mmdPath = path.join(outDir, `${d.name}.mmd`);
    fs.writeFileSync(mmdPath, d.mermaid);

    const svgPath = path.join(outDir, `${d.name}.svg`);
    const mmdc = path.join(gendocsRoot, 'node_modules/.bin/mmdc');
    execSync(`"${mmdc}" -i "${mmdPath}" -o "${svgPath}" -c "${configPath}" -b white --quiet`, { timeout: 30000 });

    let svgContent = fs.readFileSync(svgPath, 'utf-8');
    const svgStart = svgContent.indexOf('<svg');
    const svgEnd = svgContent.lastIndexOf('</svg>');
    if (svgStart > 0) svgContent = svgContent.substring(svgStart, svgEnd + '</svg>'.length);

    const participants = _extractSequenceParticipants(d.mermaid);
    console.log(`  Participants: ${participants.join(', ')}`);
    svgContent = _recolorSequenceParticipants(svgContent, themeConfig, participants);

    const png = await svgToPng(svgContent, 2, 'Malgun Gothic');
    const outPath = path.join(outDir, `${d.name}.png`);
    fs.writeFileSync(outPath, png);
    console.log(`  -> ${outPath}`);

    try { fs.unlinkSync(configPath); } catch(e) {}
    try { fs.unlinkSync(mmdPath); } catch(e) {}
    try { fs.unlinkSync(svgPath); } catch(e) {}
  }

  console.log('\nDone!');
  process.exit(0);
}

render().catch(e => { console.error(e); process.exit(1); });
