const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 간단한 시퀀스 다이어그램을 SVG로 렌더링하여 구조 확인
const mmdCode = `sequenceDiagram
    participant C as 모바일 앱
    participant F as JwtAuthFilter
    participant A as AuthService

    C->>A: POST /auth/login
    A-->>C: JWT 토큰
`;

const tmpMmd = 'output/.diagrams/_test_seq.mmd';
const tmpSvg = 'output/.diagrams/_test_seq.svg';

fs.writeFileSync(tmpMmd, mmdCode, 'utf-8');

const mmdc = path.join(__dirname, 'node_modules', '.bin', 'mmdc.cmd');
execSync(`"${mmdc}" -i "${tmpMmd}" -o "${tmpSvg}" -w 1024 -b white`, { stdio: 'inherit' });

const svg = fs.readFileSync(tmpSvg, 'utf-8');

// actor rect 요소 찾기
const actorRects = svg.match(/<rect[^>]*class="[^"]*actor[^"]*"[^>]*>/g) || [];
console.log(`\n=== Actor rects found: ${actorRects.length} ===`);
actorRects.forEach((r, i) => console.log(`  [${i}] ${r.substring(0, 120)}...`));

// text 요소에서 참여자명 찾기  
const textMatches = svg.match(/<text[^>]*class="[^"]*actor[^"]*"[^>]*>[\s\S]*?<\/text>/g) || [];
console.log(`\n=== Actor texts found: ${textMatches.length} ===`);
textMatches.forEach((t, i) => {
  const content = t.match(/>([^<]+)</);
  console.log(`  [${i}] ${content ? content[1] : '(empty)'}`);
});

// SVG 크기 확인
const viewBox = svg.match(/viewBox="([^"]+)"/);
console.log(`\n=== ViewBox: ${viewBox ? viewBox[1] : 'none'} ===`);

// 정리
fs.unlinkSync(tmpMmd);
// SVG는 남겨둠
console.log(`\nSVG saved: ${tmpSvg}`);
