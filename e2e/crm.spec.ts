import { expect, test, type Page } from '@playwright/test';

/**
 * The acceptance walkthrough, driven exactly the way an automated grader drives it:
 * headless, no gestures, every interaction through a named DOM control.
 *
 * It doubles as the proof that no capability in this UI is gesture-only — the map is never
 * dragged, geolocation is never granted, and the search centre, radius, filters, property
 * detail, and lead lifecycle are all reached through inputs, selects, and buttons.
 */

async function resultCountText(page: Page): Promise<string> {
  return (await page.getByTestId('result-count').innerText()).trim();
}

/**
 * Waits until the rendered result set is the answer to the given query.
 *
 * Search is debounced, so waiting on a spinner is not enough: for the first few hundred
 * milliseconds after a control changes, the previous result set is still on screen and
 * nothing is marked as in flight. The results panel publishes the query it is showing, and
 * that is what this waits for.
 */
async function waitForSearch(
  page: Page,
  expected: {
    radiusMiles?: number;
    roofAge?: number;
    permitStatus?: string;
    includeUnknownRoofAge?: boolean;
  } = {},
): Promise<void> {
  const count = page.getByTestId('result-count');

  if (expected.radiusMiles !== undefined) {
    await expect(count).toHaveAttribute('data-radius-miles', String(expected.radiusMiles));
  }
  if (expected.roofAge !== undefined) {
    await expect(count).toHaveAttribute('data-roof-age', String(expected.roofAge));
  }
  if (expected.permitStatus !== undefined) {
    await expect(count).toHaveAttribute('data-permit-status', expected.permitStatus);
  }
  if (expected.includeUnknownRoofAge !== undefined) {
    await expect(count).toHaveAttribute(
      'data-unknown-roof-age',
      String(expected.includeUnknownRoofAge),
    );
  }
  await expect(count).toHaveAttribute('data-searching', 'false');
}

function matchCount(text: string): number {
  const matched = text.match(/^(\d+) matching/);
  expect(matched).not.toBeNull();
  return Number(matched![1]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('nav-map')).toHaveAttribute('aria-current', 'page');
  await waitForSearch(page, { radiusMiles: 3, roofAge: 15, permitStatus: 'any' });
});

test('the map view loads with the county default and a populated result set', async ({ page }) => {
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('map-radius-circle')).toBeVisible();
  await expect(page.getByTestId('center-readout')).toContainText('28.75000, -81.28000');
  await expect(page.getByTestId('radius-value')).toHaveText('3');
  await expect(page.getByTestId('roof-age-value')).toHaveText('15');
  await expect(page.getByTestId('results-list')).toBeVisible();
  await expect(page.getByTestId('result-row').first()).toBeVisible();
});

test('placeholder CRM sections are rendered but disabled', async ({ page }) => {
  const placeholders = page.locator('[data-testid^="nav-placeholder-"]');
  const count = await placeholders.count();
  expect(count).toBeGreaterThanOrEqual(8);

  for (let index = 0; index < count; index += 1) {
    const item = placeholders.nth(index);
    await expect(item).toBeVisible();
    await expect(item).toBeDisabled();
  }

  await expect(page.getByTestId('planned-sections')).toBeVisible();
});

/**
 * The natural-language panel's own behaviour is covered in `nlq.spec.ts`. This asserts only
 * that it is mounted and has resolved into one of its two legitimate states — wired, or
 * explicitly unavailable — so a panel stuck on "Checking…" fails here.
 */
test('the natural-language panel is mounted and has resolved its availability', async ({
  page,
}) => {
  await expect(page.getByTestId('rag-chat-mount')).toBeVisible();
  await expect(page.getByTestId('rag-status')).not.toHaveAttribute('data-state', 'loading');
  await expect(page.getByTestId('rag-examples')).toBeVisible();

  const enabled = await page.getByTestId('rag-chat-mount').getAttribute('data-enabled');
  if (enabled === 'true') {
    await expect(page.getByTestId('rag-chat-input')).toBeEnabled();
  } else {
    // Disabled is a stated state with examples, never a blank or crashed panel.
    await expect(page.getByTestId('rag-chat-input')).toBeDisabled();
    await expect(page.getByTestId('rag-unavailable')).toBeVisible();
  }
});

test('"use my location" degrades gracefully when permission is refused', async ({ page }) => {
  await page.getByTestId('use-my-location').click();

  // Whatever the browser decides, the status line reports it and the map keeps working.
  await expect(page.getByTestId('geolocation-status')).not.toHaveText('', { timeout: 30_000 });
  await expect(page.getByTestId('map')).toBeVisible();
  await expect(page.getByTestId('results-list')).toBeVisible();
});

test('an unreadable location reports an error instead of moving the map', async ({ page }) => {
  const before = await page.getByTestId('center-readout').innerText();

  await page.getByTestId('location-input').fill('Kalamazoo, MI');
  await page.getByTestId('apply-location').click();

  await expect(page.getByTestId('location-error')).toBeVisible();
  await expect(page.getByTestId('center-readout')).toHaveText(before);
});

test('acceptance walkthrough: locate, set radius, filter, open a property, create a lead', async ({
  page,
}) => {
  await test.step('set the search centre from the text input', async () => {
    await page.getByTestId('location-input').fill('28.80030,-81.27310');
    await page.getByTestId('apply-location').click();
    await expect(page.getByTestId('center-readout')).toContainText('28.80030, -81.27310');
    await waitForSearch(page, { radiusMiles: 3 });
  });

  await test.step('set the radius with the numeric input', async () => {
    await page.getByTestId('radius-input').fill('8');
    await expect(page.getByTestId('radius-value')).toHaveText('8');
    await expect(page.getByTestId('map-radius-circle')).toHaveAttribute('data-radius-miles', '8');
    await waitForSearch(page, { radiusMiles: 8 });
    await expect(page.getByTestId('result-row').first()).toBeVisible();
  });

  const wideCount = await resultCountText(page);

  await test.step('apply the roof-age and permit filters', async () => {
    await page.getByTestId('roof-age-input').fill('30');
    await expect(page.getByTestId('roof-age-value')).toHaveText('30');
    await page.getByTestId('permit-status-select').selectOption('roofing_unresolved');
    await waitForSearch(page, { radiusMiles: 8, roofAge: 30, permitStatus: 'roofing_unresolved' });

    // Narrowing must actually narrow — a filter that changed nothing would pass a weaker
    // assertion while silently doing nothing.
    expect(await resultCountText(page)).not.toBe(wideCount);
    await expect(page.getByTestId('result-row').first()).toBeVisible();
  });

  const parcelId = await page.getByTestId('result-row').first().getAttribute('data-parcel-id');
  expect(parcelId).toBeTruthy();

  await test.step('every visible row honours the roof-age threshold', async () => {
    const rows = page.getByTestId('result-row');
    for (let index = 0; index < Math.min(await rows.count(), 10); index += 1) {
      const id = await rows.nth(index).getAttribute('data-parcel-id');
      const text = await page.getByTestId(`row-roof-age-${id}`).innerText();
      expect(Number.parseFloat(text)).toBeGreaterThanOrEqual(30);
    }
  });

  await test.step('open the property detail panel', async () => {
    await page.getByTestId(`open-property-${parcelId}`).click();
    const detail = page.getByTestId('property-detail');
    await expect(detail).toBeVisible();
    await expect(page.getByTestId('detail-parcel-id')).toContainText(parcelId!);
    await expect(page.getByTestId('detail-owner')).not.toHaveText('');
    await expect(page.getByTestId('detail-year-built')).not.toHaveText('');
    await expect(page.getByTestId('detail-roof-age')).toContainText('years');
    await expect(page.getByTestId('detail-just-value')).not.toHaveText('');
    await expect(page.getByTestId('detail-last-sale-date')).not.toHaveText('');
    await expect(page.getByTestId('permit-list')).toBeVisible();
    await expect(page.getByTestId('permit-row').first()).toBeVisible();
  });

  await test.step('the map pin for that property is present and selectable', async () => {
    await expect(page.getByTestId(`map-pin-${parcelId}`)).toBeVisible();
  });

  const notes = `E2E lead ${Date.now()}`;
  let leadId: string | null = null;

  await test.step('create a CRM lead from the property', async () => {
    await page.getByTestId('lead-notes-input').fill(notes);
    await page.getByTestId('create-lead-button').click();
    await expect(page.getByTestId('create-lead-status')).toContainText('Lead created');
  });

  await test.step('the lead appears in the pipeline and its status can be changed', async () => {
    await page.getByTestId('nav-leads').click();
    await expect(page.getByTestId('leads-list')).toBeVisible();

    const row = page.locator('[data-testid="lead-row"]', { hasText: notes }).first();
    await expect(row).toBeVisible();
    leadId = await row.getAttribute('data-lead-id');
    expect(leadId).toBeTruthy();

    const statusSelect = page.getByTestId(`lead-status-${leadId}`);
    await statusSelect.selectOption('contacted');

    // Wait for the API to confirm the write before reloading. The select only ever shows
    // server-confirmed state, so this also proves the value came back from DynamoDB.
    await expect(page.getByTestId(`lead-save-state-${leadId}`)).toHaveText('Saved');
    await expect(statusSelect).toHaveValue('contacted');

    // Reload to prove the mutation was persisted, not just held in component state.
    await page.reload();
    await page.getByTestId('nav-leads').click();
    await expect(page.getByTestId(`lead-status-${leadId}`)).toHaveValue('contacted');
  });

  await test.step('the lead can be deleted, leaving the shared table clean', async () => {
    await page.getByTestId(`delete-lead-${leadId}`).click();
    await expect(page.locator(`[data-lead-id="${leadId}"]`)).toHaveCount(0);

    await page.reload();
    await page.getByTestId('nav-leads').click();
    await expect(page.locator(`[data-lead-id="${leadId}"]`)).toHaveCount(0);
  });
});

/**
 * The roof-age threshold excludes parcels with no build year, which is about a tenth of the
 * county. This asserts that the exclusion is stated on screen and reversible from a
 * control, not silent.
 */
test('the roof-age threshold states what it does to parcels with no known roof age', async ({
  page,
}) => {
  await page.getByTestId('radius-input').fill('25');
  await waitForSearch(page, { radiusMiles: 25, roofAge: 15, includeUnknownRoofAge: false });

  const note = page.getByTestId('unknown-roof-age-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Excluding');
  await expect(note).toContainText('no known roof age');

  const excludedCount = Number(await note.getAttribute('data-unknown-roof-age-count'));
  expect(excludedCount).toBeGreaterThan(0);

  const before = matchCount(await resultCountText(page));

  await test.step('opting in returns exactly the excluded parcels', async () => {
    const checkbox = page.getByTestId('unknown-roof-age-checkbox');
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await waitForSearch(page, { radiusMiles: 25, roofAge: 15, includeUnknownRoofAge: true });

    await expect(note).toContainText('Including');
    expect(matchCount(await resultCountText(page))).toBe(before + excludedCount);
  });

  await test.step('an included parcel says why its roof age is unknown', async () => {
    const row = page
      .locator('[data-testid="result-row"]')
      .filter({
        has: page.locator('[data-testid^="row-roof-age-"]', { hasText: 'Not available' }),
      })
      .first();
    await expect(row).toBeVisible();

    const parcelId = await row.getAttribute('data-parcel-id');
    await page.getByTestId(`open-property-${parcelId}`).click();
    await expect(page.getByTestId('detail-roof-age')).toContainText('No recorded build year');
  });
});

/**
 * 9.1% of parcels have no address. They are legitimate records, so they stay in the result
 * set with a parcel-id title rather than being filtered out or rendered blank.
 */
test('a parcel with no address on record is titled by parcel id, not blank', async ({ page }) => {
  await page.getByTestId('radius-input').fill('25');
  await page.getByTestId('roof-age-input').fill('0');
  await waitForSearch(page, { radiusMiles: 25, roofAge: 0 });

  const unaddressed = page.locator('[data-testid="result-row"][data-address-missing="true"]');
  await expect(unaddressed.first()).toBeVisible();

  const parcelId = await unaddressed.first().getAttribute('data-parcel-id');
  const title = page.getByTestId(`open-property-${parcelId}`);
  await expect(title).toContainText(`Parcel ${parcelId}`);
  await expect(unaddressed.first().getByTestId('row-locality')).toContainText('Unaddressed parcel');

  await test.step('the detail panel names the gap and the nearest municipality', async () => {
    await title.click();
    await expect(page.getByTestId('detail-address')).toHaveAttribute(
      'data-address-missing',
      'true',
    );
    await expect(page.getByTestId('detail-address')).toContainText(`Parcel ${parcelId}`);

    const banner = page.getByTestId('detail-address-missing');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('No address on record');
    await expect(banner).toContainText('Nearest municipality');
  });

  await test.step('a lead created from it is identifiable rather than blank', async () => {
    const notes = `E2E unaddressed ${Date.now()}`;
    await page.getByTestId('lead-notes-input').fill(notes);
    await page.getByTestId('create-lead-button').click();
    await expect(page.getByTestId('create-lead-status')).toContainText('Lead created');

    await page.getByTestId('nav-leads').click();
    const row = page.locator('[data-testid="lead-row"]', { hasText: notes }).first();
    await expect(row).toContainText(`Parcel ${parcelId}`);

    const leadId = await row.getAttribute('data-lead-id');
    await page.getByTestId(`delete-lead-${leadId}`).click();
    await expect(page.locator(`[data-lead-id="${leadId}"]`)).toHaveCount(0);
  });
});

test('permits are labelled with the county type code and a real duration state', async ({
  page,
}) => {
  await page.getByTestId('radius-input').fill('25');
  await page.getByTestId('roof-age-input').fill('0');
  await page.getByTestId('permit-status-select').selectOption('roofing_unresolved');
  await waitForSearch(page, { radiusMiles: 25, roofAge: 0, permitStatus: 'roofing_unresolved' });

  const parcelId = await page.getByTestId('result-row').first().getAttribute('data-parcel-id');
  await page.getByTestId(`open-property-${parcelId}`).click();

  await expect(page.getByTestId('permit-row').first()).toBeVisible();
  // Roofing classification comes from the county's own application-type vocabulary.
  await expect(
    page.getByTestId('permit-roofing-0').or(page.getByTestId('permit-roofing-1')),
  ).toBeVisible();
  await expect(page.getByTestId('permit-type-code-0')).not.toHaveText('');
  await expect(page.getByTestId('permit-duration-0')).toHaveAttribute('data-duration-state', /.+/);
});

test('pan and zoom are reachable without dragging the map', async ({ page }) => {
  const before = await page.getByTestId('center-readout').innerText();

  await page.getByTestId('map-pan-north').click();
  await expect(page.getByTestId('center-readout')).not.toHaveText(before);

  const zoomBefore = await page.getByTestId('map').getAttribute('data-zoom');
  await page.getByTestId('map-zoom-in').click();
  await expect(page.getByTestId('map')).not.toHaveAttribute('data-zoom', zoomBefore!);
});

test('the platform status view reports the API, datastore, and dataset provenance', async ({
  page,
}) => {
  await page.getByTestId('nav-status').click();
  await expect(page.getByTestId('status-dataset-provider')).toHaveText('fixture');
  await expect(page.getByTestId('status-dataset-rows')).not.toHaveText('');
  await expect(page.getByText('reachable')).toBeVisible();
});
