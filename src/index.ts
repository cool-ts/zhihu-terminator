import { Page, firefox, ElementHandle } from 'playwright';
import axios from 'axios';

const indexUrl = 'https://www.zhihu.com';
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
    await page.goto(indexUrl);
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

async function deleteAllFollowingQuestions(page: Page, username: string) {
    const visited = new Set<string>();
    const questions = `https://www.zhihu.com/people/${username}/following/questions`;
    await page.goto(questions);

    while (true) {
        try {
            await page.waitForSelector('.List#Profile-following .ContentItem');

            const questionUrls = await page.$$eval(
                '.List#Profile-following .ContentItem .QuestionItem-title a',
                (nodes: HTMLAnchorElement[]) => nodes.map(node => node.href)
            );
            const firstNotBannedQuestion = questionUrls.find(
                url => !visited.has(url)
            );
            if (!firstNotBannedQuestion) {
                if (questionUrls.length) {
                    const nextPage = await page.$('.PaginationButton-next');
                    if (nextPage) {
                        await nextPage.click();
                        continue;
                    }
                }
                return;
            }

            visited.add(firstNotBannedQuestion);
            await page.goto(firstNotBannedQuestion);

            const errorContainer = await page.$('.ErrorPage-container');
            if (errorContainer) {
                await page.goBack();
                continue;
            }

            const followButton = await page.waitForSelector(
                '.QuestionHeader .QuestionButtonGroup .FollowButton'
            );
            const followButtonTextContent = await followButton.evaluate(
                node => node.textContent
            );
            if (followButtonTextContent !== '已关注') {
                await page.goBack();
                continue;
            }

            await followButton.click();
            await page.goBack();
        } catch (e) {
            console.log('cannot unfollow questions anymore');
            return;
        }
    }
}

interface IPaging {
    is_end?: boolean;
    next?: string;
}

interface IQuestion {
    id: number;
}

interface IAnswerTarget {
    id: number;
    question: IQuestion;
}

interface IArtifactTarget {
    id: number;
}

interface IAnswerData {
    verb: 'ANSWER_VOTE_UP';
    target: IAnswerTarget;
}

interface IArtifactData {
    verb: 'MEMBER_VOTEUP_ARTICLE';
    target: IArtifactTarget;
}

interface IUnknownData {
    verb: 'MEMBER_VOTEUP_ARTICLE';
    target: { id: number };
}

type IData = IAnswerData | IArtifactData | IUnknownData;

interface IActivity {
    paging?: IPaging;
    data?: IData[];
}

async function unVoteAllAnswersOrArticle(page: Page, username: string) {
    const visited = new Set<number>();
    const activitiesUrl = `https://www.zhihu.com/api/v3/feed/members/${username}/activities`;

    const queue = [activitiesUrl];
    while (queue.length) {
        const firstApiUrl = queue.shift();
        assertDef(firstApiUrl);

        const rawResp = await axios.get(firstApiUrl);
        const resp = rawResp.data as IActivity;

        if (!resp.paging?.is_end && resp.paging?.next) {
            queue.push(resp.paging.next);
        }

        if (!resp.data?.length) {
            return;
        }

        for (const d of resp.data) {
            if (
                d.verb !== 'ANSWER_VOTE_UP' &&
                d.verb !== 'MEMBER_VOTEUP_ARTICLE'
            ) {
                continue;
            }

            if (visited.has(d.target.id)) {
                continue;
            }
            visited.add(d.target.id);

            if (d.verb === 'ANSWER_VOTE_UP') {
                const answerUrl = `https://www.zhihu.com/question/${d.target.question.id}/answer/${d.target.id}`;
                await page.goto(answerUrl);
            } else if (d.verb === 'MEMBER_VOTEUP_ARTICLE') {
                const artifactUrl = `https://zhuanlan.zhihu.com/p/${d.target.id}`;
                await page.goto(artifactUrl);
            } else {
                continue;
            }

            const voteButton = await page.waitForSelector('.VoteButton--up');
            await voteButton.dispatchEvent('click');
            await page.waitForTimeout(500);
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
        await unVoteAllAnswersOrArticle(page, username);
        // await deleteAllFollowingQuestions(page, username);
        // await deleteAllAnswers(page, username);
        // await deleteAllPins(page, username);
    } finally {
        page.close();
        browser.close();
    }
}

main().then(() => {
    console.log('Done');
});
