const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: true });

  for (const label of ['orig', 'gen']) {
    const pdfPath = path.resolve('output/compare/' + label + '.pdf');
    if (!fs.existsSync(pdfPath)) { console.log(label + ': PDF not found'); continue; }

    const page = await browser.newPage();
    await page.setViewport({ width: 850, height: 1200, deviceScaleFactor: 2 });

    const fileUrl = 'file:///' + pdfPath.replace(/\\/g, '/');
    await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    await page.screenshot({ path: 'output/compare/' + label + '_page.png', fullPage: false });
    console.log(label + ': screenshot saved');
    await page.close();
  }

  await browser.close();
})();
