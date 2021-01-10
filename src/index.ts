import { Page, firefox, ElementHandle } from 'playwright';

const signInUrl = 'https://www.zhihu.com/signin';
const signInApiUrl = 'https://www.zhihu.com/api/v3/oauth/sign_in';
const profileUrlPrefix = 'https://www.zhihu.com/people/';
const qrScanRegex = /^https:\/\/www.zhihu.com\/api\/v3\/account\/api\/login\/qrcode\/[\w_]*\/scan_info/;

function assertDef<T>(
    v: T | undefined | null,
    message?: string
): asserts v is T {
    if (v === undefined || v === null) {
        throw new Error(message || 'Must be defined');
    }
}

async function waitUntilLogin() {
    const browser = await firefox.launch({
        headless: false
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto(signInUrl);
        await new Promise(resolve => {
            page.on('response', async resp => {
                if (resp.url() === signInApiUrl && resp.ok()) {
                    resolve(undefined);
                }
                if (qrScanRegex.test(resp.url()) && resp.ok()) {
                    const body = await resp.json();
                    if ('user_id' in body) {
                        resolve(undefined);
                    }
                }
            });
        });
        return await context.cookies();
    } finally {
        await page.close();
        await browser.close();
    }
}

async function fetchProfile(page: Page) {
    await page.goto('https://www.zhihu.com/');
    const avatar = await page.waitForSelector('.AppHeader-profileAvatar');
    await avatar.click();

    const menu = await page.waitForSelector('.AppHeaderProfileMenu');
    const itemsHref = await menu.$$eval(
        'a.AppHeaderProfileMenu-item',
        (nodes: HTMLAnchorElement[]) => nodes.map(n => n.href)
    );
    const profileUrl = itemsHref.find(item =>
        item.startsWith(profileUrlPrefix)
    );
    assertDef(profileUrl, 'Cannot find profile item');

    const username = profileUrl.replace(profileUrlPrefix, '');
    return username;
}

async function findDeleteButton(
    items: ElementHandle<SVGElement | HTMLElement>[]
) {
    for (const item of items.reverse()) {
        const textContent = await item.evaluate(node => node.textContent);
        if (textContent?.trim() === '删除') {
            return item;
        }
    }
    return undefined;
}

async function deleteAllAnswers(page: Page, username: string) {
    while (true) {
        try {
            const answers = `https://www.zhihu.com/people/${username}/answers`;
            await page.goto(answers);

            const oneAnswer = await page.waitForSelector(
                '.List.Profile-answers .ContentItem.AnswerItem'
            );
            const settingsButton = await oneAnswer.$('svg.Zi--Settings');
            assertDef(settingsButton, 'Cannot find settings button');
            await settingsButton.dispatchEvent('click');

            const popover = await page.waitForSelector('.Popover-content');
            const items = await popover.$$('.Menu-item');
            const deleteButton = await findDeleteButton(items);
            assertDef(deleteButton, 'Cannot find delete button');
            await deleteButton.click();

            const confirmButton = await page.waitForSelector(
                '.ConfirmModal .Button.Button--primary'
            );
            await confirmButton.click();
        } catch (e) {
            console.log('cannot delete answers anymore');
            return;
        }
    }
}

async function deleteAllPins(page: Page, username: string) {
    while (true) {
        try {
            const pins = `https://www.zhihu.com/people/${username}/pins`;
            await page.goto(pins);

            const onePin = await page.waitForSelector(
                '.List#Profile-posts .ContentItem.PinItem'
            );
            const deleteButton = await onePin.$('svg.Zi--Close');
            assertDef(deleteButton, 'Cannot find delete button');
            await deleteButton.dispatchEvent('click');

            const confirmButton = await page.waitForSelector(
                '.ConfirmModal .Button.Button--primary'
            );
            await confirmButton.click();
        } catch (e) {
            console.log('cannot delete pins anymore');
            return;
        }
    }
}

async function main() {
    const cookies = await waitUntilLogin();
    const browser = await firefox.launch({
        headless: false
    });
    const context = await browser.newContext();
    context.addCookies(cookies);
    const page = await context.newPage();

    try {
        const username = await fetchProfile(page);
        await deleteAllAnswers(page, username);
        await deleteAllPins(page, username);
    } finally {
        page.close();
        browser.close();
    }
}

main().then(() => {
    console.log('Done');
});
