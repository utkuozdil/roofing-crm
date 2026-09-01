import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The natural-language query walkthrough, driven the way a grading harness drives it: type a
 * question into a real textarea, submit with a real button, and assert on the interpretation
 * and on the rows.
 *
 * Every assertion here is about the *link* between the two. It is not enough that a plausible
 * sentence appeared: the interpretation publishes the filters it claims to have applied, the
 * results panel publishes the filters the rendered rows actually answer, and these tests check
 * that those agree and that the rows themselves satisfy the criteria. That check is only
 * possible because the engine parses to structured filters — there would be nothing to compare
 * against if the answer came from vector similarity.
 *
 * Questions go to a language model, so the tests assert on what must be true of any correct
 * parse (the place resolved, the threshold applied, the rows satisfying it) rather than on an
 * exact filter value the model is free to choose.
 */

/** Skips the run with a clear reason rather than failing if no model is configured. */
async function requireEnabled(page: Page): Promise<void> {
  const mount = page.getByTestId('rag-chat-mount');
  await expect(mount).toBeVisible();
  await expect(page.getByTestId('rag-status')).not.toHaveAttribute('data-state', 'loading');

  const enabled = await mount.getAttribute('data-enabled');
  test.skip(
    enabled !== 'true',
    'No language model is configured for this deployment, so the panel is in its disabled state.',
  );
}

/** Asks a question and waits for the interpretation the answer is echoed through. */
async function ask(page: Page, question: string): Promise<Locator> {
  await page.getByTestId('rag-chat-input').fill(question);
  await page.getByTestId('rag-chat-send').click();

  const interpretation = page.getByTestId('rag-interpretation');
  await expect(interpretation).toBeVisible();
  await expect(page.getByTestId('rag-status')).not.toHaveAttribute('data-state', 'asking');
  return interpretation;
}

/**
 * Waits until the results list is answering the query the chat says it applied.
 *
 * Search is debounced, so the previous rows stay on screen for a moment after the chat
 * answers. Both panels publish their query, so settling is observable rather than timed.
 */
async function waitForResultsToMatch(page: Page, interpretation: Locator): Promise<void> {
  const count = page.getByTestId('result-count');
  for (const attribute of [
    'data-radius-miles',
    'data-roof-age',
    'data-out-of-area',
    'data-pool',
    'data-sold-since',
    'data-min-just-value',
    'data-years-since-sale',
    'data-sort',
  ]) {
    const expected = await interpretation.getAttribute(attribute);
    expect(expected, `${attribute} should be published by the interpretation`).not.toBeNull();
    await expect(count).toHaveAttribute(attribute, expected!);
  }
  await expect(count).toHaveAttribute('data-searching', 'false');
}

function matchCount(text: string): number {
  const matched = text.match(/^(\d+) matching/);
  expect(matched, `unexpected result-count text: ${text}`).not.toBeNull();
  return Number(matched![1]);
}

/** The count the interpretation claims, and the count the rows actually answer, must agree. */
async function expectCountsAgree(page: Page, interpretation: Locator): Promise<number> {
  const claimed = Number(await interpretation.getAttribute('data-matched'));
  const rendered = matchCount((await page.getByTestId('result-count').innerText()).trim());
  expect(rendered).toBe(claimed);
  expect(await interpretation.getByTestId('rag-summary').innerText()).toContain(`${claimed} match`);
  return claimed;
}

async function criterionLabels(interpretation: Locator): Promise<string[]> {
  return interpretation.getByTestId('rag-criterion').allInnerTexts();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('result-count')).toHaveAttribute('data-searching', 'false');
  await requireEnabled(page);
});

test('“Houses near Lake Mary with roofs over 20 years old” applies a place and a roof threshold', async ({
  page,
}) => {
  const interpretation = await ask(page, 'Houses near Lake Mary with roofs over 20 years old');

  await test.step('the interpretation names the place and the threshold', async () => {
    const labels = (await criterionLabels(interpretation)).join(' | ');
    expect(labels).toContain('Lake Mary');
    expect(labels).toMatch(/roof age at least \d+ years/);

    // A roof-age question must resolve to a real threshold, not to the app's silent default.
    const roofAge = Number(await interpretation.getAttribute('data-roof-age'));
    expect(roofAge).toBeGreaterThanOrEqual(15);
  });

  await test.step('the map centre moved to Lake Mary', async () => {
    await expect(page.getByTestId('center-readout')).toContainText('Lake Mary');
    // Lake Mary is at 28.7589, -81.3178 in the county gazetteer.
    await expect(page.getByTestId('center-readout')).toContainText('28.75890, -81.31780');
  });

  await test.step('the search controls show the parsed filters', async () => {
    const roofAge = await interpretation.getAttribute('data-roof-age');
    await expect(page.getByTestId('roof-age-input')).toHaveValue(roofAge!);
    await expect(page.getByTestId('radius-input')).toHaveValue(
      (await interpretation.getAttribute('data-radius-miles'))!,
    );
  });

  await test.step('the rows answer that query and every one satisfies the threshold', async () => {
    await waitForResultsToMatch(page, interpretation);
    const matched = await expectCountsAgree(page, interpretation);
    expect(matched).toBeGreaterThan(0);

    const threshold = Number(await interpretation.getAttribute('data-roof-age'));
    const rows = page.getByTestId('result-row');
    for (let index = 0; index < Math.min(await rows.count(), 10); index += 1) {
      const parcelId = await rows.nth(index).getAttribute('data-parcel-id');
      const text = await page.getByTestId(`row-roof-age-${parcelId}`).innerText();
      expect(Number.parseFloat(text)).toBeGreaterThanOrEqual(threshold);
    }
  });

  await test.step('the exclusion of parcels with no build year is stated, not silent', async () => {
    await expect(page.getByTestId('rag-notes')).toContainText('no recorded build year');
  });
});

test('“Show me out-of-area owners with high value properties” applies both predicates county-wide', async ({
  page,
}) => {
  const interpretation = await ask(page, 'Show me out-of-area owners with high value properties');

  const labels = (await criterionLabels(interpretation)).join(' | ');
  expect(labels).toContain('outside Seminole County');
  expect(labels).toMatch(/just value at least \$[\d,]+/);

  await expect(interpretation).toHaveAttribute('data-out-of-area', 'true');
  expect(Number(await interpretation.getAttribute('data-min-just-value'))).toBeGreaterThan(0);

  await test.step('the out-of-area checkbox is ticked in the search panel', async () => {
    await expect(page.getByTestId('out-of-area-checkbox')).toBeChecked();
    await expect(page.getByTestId('min-just-value-input')).toHaveValue(
      (await interpretation.getAttribute('data-min-just-value'))!,
    );
  });

  await test.step('the rows answer that query', async () => {
    await waitForResultsToMatch(page, interpretation);
    expect(await expectCountsAgree(page, interpretation)).toBeGreaterThan(0);
  });

  /**
   * A question with no place in it is a county-wide question. Inheriting the map's 3-mile
   * radius would return a plausible but much smaller answer with nothing on screen to explain
   * the difference.
   */
  await test.step('no location in the question means the whole county', async () => {
    expect(Number(await interpretation.getAttribute('data-radius-miles'))).toBeGreaterThanOrEqual(
      25,
    );
    expect(await interpretation.getAttribute('data-center-label')).toContain('Seminole County');
  });
});

test('“Properties that haven’t sold in 20 years” does not silently apply a roof filter', async ({
  page,
}) => {
  const interpretation = await ask(page, 'Properties that haven’t sold in 20 years');

  const labels = (await criterionLabels(interpretation)).join(' | ');
  expect(labels).toMatch(/no sale in the last \d+ years/);
  expect(Number(await interpretation.getAttribute('data-years-since-sale'))).toBeGreaterThanOrEqual(
    15,
  );

  /**
   * The app defaults to a 15-year roof threshold. This question says nothing about roofs, so
   * applying it would drop every newer-roofed parcel and make the reported count a quiet lie.
   */
  await test.step('the roof-age threshold is off, in the answer and in the control', async () => {
    await expect(interpretation).toHaveAttribute('data-roof-age', '0');
    expect(labels).not.toContain('roof age');
    await expect(page.getByTestId('roof-age-input')).toHaveValue('0');
  });

  await test.step('the rows answer that query and include newer roofs', async () => {
    await waitForResultsToMatch(page, interpretation);
    expect(await expectCountsAgree(page, interpretation)).toBeGreaterThan(0);

    const rows = page.getByTestId('result-row');
    const roofAges: number[] = [];
    for (let index = 0; index < Math.min(await rows.count(), 25); index += 1) {
      const parcelId = await rows.nth(index).getAttribute('data-parcel-id');
      const text = await page.getByTestId(`row-roof-age-${parcelId}`).innerText();
      const years = Number.parseFloat(text);
      if (Number.isFinite(years)) roofAges.push(years);
    }
    expect(roofAges.length).toBeGreaterThan(0);
    // Proof the threshold is genuinely absent rather than merely reported as absent.
    expect(Math.min(...roofAges)).toBeLessThan(15);
  });
});

test('“Old roofs in Sanford” resolves a bare place name and a vague age', async ({ page }) => {
  const interpretation = await ask(page, 'Old roofs in Sanford');

  expect((await criterionLabels(interpretation)).join(' | ')).toContain('Sanford');
  expect(Number(await interpretation.getAttribute('data-roof-age'))).toBeGreaterThanOrEqual(15);
  await expect(page.getByTestId('center-readout')).toContainText('Sanford');

  await waitForResultsToMatch(page, interpretation);
  expect(await expectCountsAgree(page, interpretation)).toBeGreaterThan(0);
});

test('“Homes with a pool that sold since 2020” applies two filters the map controls also expose', async ({
  page,
}) => {
  const interpretation = await ask(page, 'Homes with a pool that sold since 2020');

  await expect(interpretation).toHaveAttribute('data-pool', 'with_pool');
  await expect(interpretation).toHaveAttribute('data-sold-since', '2020');

  const labels = (await criterionLabels(interpretation)).join(' | ');
  expect(labels).toContain('has a pool');
  expect(labels).toContain('sold since 2020');

  await test.step('both controls moved in the search panel', async () => {
    await expect(page.getByTestId('pool-select')).toHaveValue('with_pool');
    await expect(page.getByTestId('sold-since-input')).toHaveValue('2020');
  });

  await test.step('the rows answer that query', async () => {
    await waitForResultsToMatch(page, interpretation);
    expect(await expectCountsAgree(page, interpretation)).toBeGreaterThan(0);
  });
});

/**
 * The refusal path. A question the CRM cannot express as a filter must say so and say what it
 * can do — never return an empty list, which is indistinguishable from a broken search, and
 * never move the map.
 */
test('a nonsensical question is refused, and the map is left alone', async ({ page }) => {
  const centreBefore = await page.getByTestId('center-readout').innerText();
  const countBefore = (await page.getByTestId('result-count').innerText()).trim();

  await page
    .getByTestId('rag-chat-input')
    .fill('What is the capital of Peru, and please write me a haiku about lasagne');
  await page.getByTestId('rag-chat-send').click();

  const refusal = page.getByTestId('rag-refusal');
  await expect(refusal).toBeVisible();
  await expect(page.getByTestId('rag-refusal-message')).toContainText('can’t answer that');

  await test.step('the refusal states what the engine can do instead', async () => {
    const capabilities = page.getByTestId('rag-capabilities');
    await expect(capabilities).toBeVisible();
    expect((await capabilities.locator('li').allInnerTexts()).length).toBeGreaterThan(2);
  });

  await test.step('nothing was applied: no interpretation, no map movement, same rows', async () => {
    await expect(page.getByTestId('rag-interpretation')).toHaveCount(0);
    await expect(page.getByTestId('center-readout')).toHaveText(centreBefore);
    await expect(page.getByTestId('result-count')).toHaveText(countBefore);
  });
});

test('a question about another county is refused rather than answered with local rows', async ({
  page,
}) => {
  const centreBefore = await page.getByTestId('center-readout').innerText();

  await page.getByTestId('rag-chat-input').fill('Old roofs in Kalamazoo, Michigan');
  await page.getByTestId('rag-chat-send').click();

  await expect(page.getByTestId('rag-refusal')).toBeVisible();
  await expect(page.getByTestId('rag-refusal-message')).toContainText(/Kalamazoo/i);
  // The refusal states the scope whichever layer produced it — the model for an off-topic
  // question, the county gazetteer for a place it cannot resolve.
  await expect(page.getByTestId('rag-refusal-scope')).toContainText('Seminole County, FL only');
  await expect(page.getByTestId('center-readout')).toHaveText(centreBefore);
});

test('an example question can be run from the panel itself', async ({ page }) => {
  await page.getByTestId('rag-example-0').click();

  const interpretation = page.getByTestId('rag-interpretation');
  await expect(interpretation).toBeVisible();
  await expect(page.getByTestId('rag-chat-input')).not.toHaveValue('');
  await expect(page.getByTestId('rag-applied')).toBeVisible();

  await waitForResultsToMatch(page, interpretation);
  await expectCountsAgree(page, interpretation);
});

/** The chat drives the app, so a filter it set must still be adjustable by hand afterwards. */
test('a chat-applied filter can be overridden from the search panel', async ({ page }) => {
  const interpretation = await ask(page, 'Old roofs in Sanford');
  await waitForResultsToMatch(page, interpretation);
  const afterChat = matchCount((await page.getByTestId('result-count').innerText()).trim());

  await page.getByTestId('roof-age-input').fill('0');
  await expect(page.getByTestId('result-count')).toHaveAttribute('data-roof-age', '0');
  await expect(page.getByTestId('result-count')).toHaveAttribute('data-searching', 'false');

  // Dropping the threshold can only widen the set, and the panel is now the source of truth.
  expect(
    matchCount((await page.getByTestId('result-count').innerText()).trim()),
  ).toBeGreaterThanOrEqual(afterChat);
});
