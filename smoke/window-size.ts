import { expect, type Page } from '@playwright/test';

/** 系统装饰和像素取整会让高 DPI 视口与请求的逻辑尺寸相差少量像素。 */
export async function expectViewport(page: Page, width: number, height: number) {
  const tolerance = Number(process.env.DEPLOY_CENTER_TEST_SCALE || 1) > 1 ? 2 : 0;
  await expect
    .poll(async () => {
      const size = await page.evaluate(() => [innerWidth, innerHeight]);
      return Math.max(Math.abs(size[0] - width), Math.abs(size[1] - height));
    })
    .toBeLessThanOrEqual(tolerance);
}
