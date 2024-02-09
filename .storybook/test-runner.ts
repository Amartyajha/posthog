import { toMatchImageSnapshot } from 'jest-image-snapshot'
import { getStoryContext, TestRunnerConfig, TestContext, waitForPageReady } from '@storybook/test-runner'
import type { Locator, Page, LocatorScreenshotOptions } from '@playwright/test'
import type { Mocks } from '~/mocks/utils'
import { StoryContext } from '@storybook/csf'

// 'firefox' is technically supported too, but as of June 2023 it has memory usage issues that make is unusable
type SupportedBrowserName = 'chromium' | 'webkit'
type SnapshotTheme = 'legacy' | 'light' | 'dark'

// Extend Storybook interface `Parameters` with Chromatic parameters
declare module '@storybook/types' {
    interface Parameters {
        options?: any
        layout?: 'padded' | 'fullscreen' | 'centered'
        testOptions?: {
            /**
             * Whether we should wait for all loading indicators to disappear before taking a snapshot.
             * @default true
             */
            waitForLoadersToDisappear?: boolean
            /** If set, we'll wait for the given selector to be satisfied. */
            waitForSelector?: string
            /**
             * Whether navigation (sidebar + topbar) should be excluded from the snapshot.
             * Warning: Fails if enabled for stories in which navigation is not present.
             * @default false
             */
            excludeNavigationFromSnapshot?: boolean
            /**
             * The test will always run for all the browers, but snapshots are only taken in Chromium by default.
             * Override this to take snapshots in other browsers too.
             *
             * @default ['chromium']
             */
            snapshotBrowsers?: SupportedBrowserName[]
            /** If taking a component snapshot, you can narrow it down by specifying the selector. */
            snapshotTargetSelector?: string
        }
        msw?: {
            mocks?: Mocks
        }
        [name: string]: any
    }

    interface Globals {
        theme: SnapshotTheme
    }
}

const RETRY_TIMES = 3
const LOADER_SELECTORS = [
    '.ant-skeleton',
    '.Spinner',
    '.LemonSkeleton',
    '.LemonTableLoader',
    '.Toastify__toast-container',
    '[aria-busy="true"]',
    '.SessionRecordingPlayer--buffering',
    '.Lettermark--unknown',
]

const customSnapshotsDir = `${process.cwd()}/frontend/__snapshots__`

const JEST_TIMEOUT_MS = 15000
const PLAYWRIGHT_TIMEOUT_MS = 10000 // Must be shorter than JEST_TIMEOUT_MS

module.exports = {
    setup() {
        expect.extend({ toMatchImageSnapshot })
        jest.retryTimes(RETRY_TIMES, { logErrorsBeforeRetry: true })
        jest.setTimeout(JEST_TIMEOUT_MS)
    },
    async postVisit(page, context) {
        const browserContext = page.context()
        const storyContext = await getStoryContext(page, context)
        const { snapshotBrowsers = ['chromium'] } = storyContext.parameters?.testOptions ?? {}

        browserContext.setDefaultTimeout(PLAYWRIGHT_TIMEOUT_MS)
        const currentBrowser = browserContext.browser()!.browserType().name() as SupportedBrowserName
        if (snapshotBrowsers.includes(currentBrowser)) {
            await expectStoryToMatchSnapshot(page, context, storyContext, currentBrowser)
        }
    },
    tags: {
        skip: ['test-skip'], // NOTE: This is overridden by the CI action storybook-chromatic.yml to include browser specific skipping
    },
} as TestRunnerConfig

/**
 * Generates a snapshot of the story and compares it to the expected snapshot.
 * @param {Page} page - The Puppeteer page object.
 * @param {TestContext} context - The test context object.
 * @param {StoryContext} storyContext - The story context object.
 * @param {SupportedBrowserName} browser - The supported browser name.
 * @returns {Promise<void>} - Resolves when the snapshot matching is complete.
 * @description
 *   - Sets the necessary options for the snapshot test.
 *   - Stops all animations for consistent snapshots.
 *   - Waits for loaders to disappear, with a reduced timeout to exclude toasts.
 *   - Waits for a specific selector, if provided.
 *   - Waits for effects to finish.
 *   - Waits for all images to load.
 *   - Takes snapshots in both light and dark themes.
 */
async function expectStoryToMatchSnapshot(
    page: Page,
    context: TestContext,
    storyContext: StoryContext,
    browser: SupportedBrowserName
): Promise<void> {
    const {
        waitForLoadersToDisappear = true,
        waitForSelector,
        excludeNavigationFromSnapshot = false,
    } = storyContext.parameters?.testOptions ?? {}

    let check: (
        page: Page,
        context: TestContext,
        browser: SupportedBrowserName,
        theme: SnapshotTheme,
        targetSelector?: string
    ) => Promise<void>
    if (storyContext.parameters?.layout === 'fullscreen') {
        if (excludeNavigationFromSnapshot) {
            check = expectStoryToMatchSceneSnapshot
        } else {
            check = expectStoryToMatchFullPageSnapshot
        }
    } else {
        check = expectStoryToMatchComponentSnapshot
    }

    await waitForPageReady(page)
    await page.evaluate(() => {
        // Stop all animations for consistent snapshots
        document.body.classList.add('storybook-test-runner')
    })
    if (waitForLoadersToDisappear) {
        // The timeout is reduced so that we never allow toasts – they usually signify something wrong
        await page.waitForSelector(LOADER_SELECTORS.join(','), { state: 'detached', timeout: 1000 })
    }
    if (waitForSelector) {
        await page.waitForSelector(waitForSelector)
    }

    await page.waitForTimeout(400) // Wait for effects to finish

    // Wait for all images to load
    await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('img')).every((i: HTMLImageElement) => i.complete)
    )

    // snapshot light theme
    await page.evaluate(() => {
        document.body.classList.add('posthog-3000')
        document.body.setAttribute('theme', 'light')
    })

    await check(page, context, browser, 'light', storyContext.parameters?.testOptions?.snapshotTargetSelector)

    // snapshot dark theme
    await page.evaluate(() => {
        document.body.setAttribute('theme', 'dark')
    })

    await check(page, context, browser, 'dark', storyContext.parameters?.testOptions?.snapshotTargetSelector)
}

async function expectStoryToMatchFullPageSnapshot(
    page: Page,
    context: TestContext,
    browser: SupportedBrowserName,
    theme: SnapshotTheme
): Promise<void> {
    await expectLocatorToMatchStorySnapshot(page, context, browser, theme)
}

/**
 * This function is used to expect a story to match a scene snapshot.
 *
 * @param {Page} page - The page object.
 * @param {TestContext} context - The test context object.
 * @param {SupportedBrowserName} browser - The supported browser name.
 * @param {SnapshotTheme} theme - The snapshot theme.
 * @returns {Promise<void>} - Returns a promise that resolves to void.
 * @description
 *   - Sets the overflow style of .Navigation3000 to visible to prevent clipping of the screenshot.
 *   - Calls the expectLocatorToMatchStorySnapshot function passing the main locator, context, browser and theme.
 */
async function expectStoryToMatchSceneSnapshot(
    page: Page,
    context: TestContext,
    browser: SupportedBrowserName,
    theme: SnapshotTheme
): Promise<void> {
    await page.evaluate(() => {
        // The screenshot gets clipped by overflow hidden on .Navigation3000
        document.querySelector('Navigation3000')?.setAttribute('style', 'overflow: visible;')
    })

    await expectLocatorToMatchStorySnapshot(page.locator('main'), context, browser, theme)
}

/**
 * Function to expect a story to match the component snapshot.
 * 
 * @param {Page} page - The page object.
 * @param {TestContext} context - The test context object.
 * @param {SupportedBrowserName} browser - The supported browser name.
 * @param {SnapshotTheme} theme - The snapshot theme.
 * @param {string} [targetSelector='#storybook-root'] - The target selector.
 * 
 * @returns {Promise<void>} - A promise that resolves when the function is complete.
 * 
 * @description
 *   - Evaluates the page and sets the root element and its position.
 *   - Expands the root element to make popovers visible in the screenshot, if needed.
 *   - Makes the body transparent for legacy style, otherwise sets the background.
 *   - Calls expectLocatorToMatchStorySnapshot with target selector and other parameters.
 */
async function expectStoryToMatchComponentSnapshot(
    page: Page,
    context: TestContext,
    browser: SupportedBrowserName,
    theme: SnapshotTheme,
    targetSelector: string = '#storybook-root'
): Promise<void> {
    /**
     * Changes the styling of the root element to ensure all popovers are visible in the screenshot.
     * Makes the body transparent for legacy style.
     * 
     * @param {string} theme - The theme of the component.
     * @throws {Error} Throws an error if the root element cannot be found.
     * @returns {void} 
     */
    await page.evaluate((theme) => {
        const rootEl = document.getElementById('storybook-root')
        if (!rootEl) {
            throw new Error('Could not find root element')
        }
        // Make the root element (which is the default screenshot reference) hug the component
        rootEl.style.display = 'inline-block'
        // If needed, expand the root element so that all popovers are visible in the screenshot
        /**
         * Adjusts the size of the root element based on the position of the popover element.
         * @param {HTMLElement} popover - The popover element.
         * @returns {void} - Does not return a value.
         * @description
         *   - If the right edge of the popover element is outside the right edge of the root element, the width of the root element is increased.
         *   - If the bottom edge of the popover element is outside the bottom edge of the root element, the height of the root element is increased.
         *   - If the top edge of the popover element is above the top edge of the root element, the height of the root element is increased to accommodate the popover.
         *   - If the left edge of the popover element is to the left of the left edge of the root element, the width of the root element is increased to accommodate the popover.
         */
        document.querySelectorAll('.Popover').forEach((popover) => {
            const currentRootBoundingClientRect = rootEl.getBoundingClientRect()
            const popoverBoundingClientRect = popover.getBoundingClientRect()
            if (popoverBoundingClientRect.right > currentRootBoundingClientRect.right) {
                rootEl.style.width = `${popoverBoundingClientRect.right}px`
            }
            if (popoverBoundingClientRect.bottom > currentRootBoundingClientRect.bottom) {
                rootEl.style.height = `${popoverBoundingClientRect.bottom}px`
            }
            if (popoverBoundingClientRect.top < currentRootBoundingClientRect.top) {
                rootEl.style.height = `${-popoverBoundingClientRect.top + currentRootBoundingClientRect.bottom}px`
            }
            if (popoverBoundingClientRect.left < currentRootBoundingClientRect.left) {
                rootEl.style.width = `${-popoverBoundingClientRect.left + currentRootBoundingClientRect.right}px`
            }
        })
        // For legacy style, make the body transparent to take the screenshot without background
        document.body.style.background = theme === 'legacy' ? 'transparent' : 'var(--bg-3000)'
    }, theme)

    await expectLocatorToMatchStorySnapshot(page.locator(targetSelector), context, browser, theme, {
        omitBackground: true,
    })
}

/**
 * Generates a snapshot of a locator and compares it to a story snapshot.
 * @param {Locator | Page} locator - The locator or page to generate a snapshot from.
 * @param {TestContext} context - The test context.
 * @param {SupportedBrowserName} browser - The supported browser name.
 * @param {SnapshotTheme} theme - The snapshot theme.
 * @param {LocatorScreenshotOptions} options - The locator screenshot options.
 * @returns {Promise<void>} - A promise that resolves when the snapshot comparison is complete.
 * @description
 *   - Generates a snapshot of the locator using the provided options.
 *   - Sets a custom snapshot identifier based on the context, theme, and browser.
 *   - Compares the generated image with the story snapshot using the 'ssim' comparison method.
 *   - Specifies a failure threshold of 0.01 (1%) and the failure threshold type as 'percent'.
 */
async function expectLocatorToMatchStorySnapshot(
    locator: Locator | Page,
    context: TestContext,
    browser: SupportedBrowserName,
    theme: SnapshotTheme,
    options?: LocatorScreenshotOptions
): Promise<void> {
    const image = await locator.screenshot({ ...options })
    let customSnapshotIdentifier = context.id
    if (theme !== 'legacy') {
        customSnapshotIdentifier += `--${theme}`
    }
    if (browser !== 'chromium') {
        customSnapshotIdentifier += `--${browser}`
    }
    expect(image).toMatchImageSnapshot({
        customSnapshotsDir,
        customSnapshotIdentifier,
        // Compare structural similarity instead of raw pixels - reducing false positives
        // See https://github.com/americanexpress/jest-image-snapshot#recommendations-when-using-ssim-comparison
        comparisonMethod: 'ssim',
        // 0.01 would be a 1% difference
        failureThreshold: 0.01,
        failureThresholdType: 'percent',
    })
}
