const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  // Using desktop dimensions but mobile layout via responsive design
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2
  });
  
  await page.goto('https://cruise-power-analyzer.surge.sh');
  await page.waitForTimeout(1000);
  
  await page.click('text=Track');
  await page.waitForTimeout(500);
  
  // It should show 計測開始 because desktop Chromium doesn't have requestPermission
  await page.click('text=計測開始');
  await page.waitForTimeout(2000); // let the timer run a bit
  
  await page.click('text=手動ラップボタン');
  await page.waitForTimeout(500);
  
  await page.screenshot({ path: '/Users/kentachida/.gemini/antigravity/brain/ca8fe15a-b537-47e5-91a5-9826ce4804b7/prototype.png' });
  
  await browser.close();
})();
