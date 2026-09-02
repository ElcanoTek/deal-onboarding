import { useMemo } from 'react';
import { FormData } from '../types/deal';
import { activeDsps, channelCode, expandDealDsps, generateDealName, geoSlot, sspSlot } from '../lib/dealNameSlots';

// Deal-name generation lives in lib/dealNameSlots.ts (the canonical slot
// vocabulary + sanitization module — see docs/DEAL_NAMING.md). Re-exported
// here for the many existing consumers that import it from the hook.
export { generateDealName } from '../lib/dealNameSlots';

/** One row of the sidebar snapshot — the key facts of a deal at a glance. */
export interface DealMatrixItem {
  id: string;
  name: string;
  theme: string;
  ssp: string;
  sspCode: string;
  channel: string;
  geo: string;
  sheetOnly: boolean;
}

export interface DealMatrix {
  totalDeals: number;
  formula: string;
  dealNames: string[];
  /** Per-deal snapshot rows, in form order. */
  items: DealMatrixItem[];
  /** SSP code → deal count, insertion-ordered by first appearance. */
  sspCounts: [string, number][];
  /** Channel (short code) → deal count, insertion-ordered. */
  channelCounts: [string, number][];
}

function tally(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts.entries());
}

export function useDealMatrix(form: FormData): DealMatrix {
  return useMemo(() => {
    const deals = form.deals;
    const total = deals.length;

    if (total === 0) {
      return {
        totalDeals: 0,
        formula: 'No deals yet — add one to get started',
        dealNames: [],
        items: [],
        sspCounts: [],
        channelCounts: [],
      };
    }

    // Multi-DSP expansion (LOCKED product decision): total deals =
    // Audiences × Channels × SSPs × DSPs. One matrix row per (deal × DSP)
    // pair — mirrors the audit's generateNamedDeals and the batch emission,
    // so the preview count always equals what MOC will actually create.
    const pairs = expandDealDsps(deals, form);
    const items: DealMatrixItem[] = pairs.map(({ deal: d, dsp }) => {
      return {
        // Compound key: a deal expands to one row per DSP, so the deal id
        // alone is no longer unique.
        id: dsp ? `${d.id}~${dsp.id}` : d.id,
        name: generateDealName(form, d, { dsp }),
        theme: d.theme.trim(),
        ssp: d.ssp,
        sspCode: d.ssp ? sspSlot(d.ssp) : '',
        channel: d.channel ? channelCode(d.channel) : '',
        geo: geoSlot(d, form),
        sheetOnly: !!d.sheetOnly,
      };
    });

    const names = items.map(i => i.name);
    const uniqueChannels = new Set(deals.map(d => d.channel).filter(Boolean)).size;
    const uniqueSsps = new Set(deals.map(d => d.ssp).filter(Boolean)).size;
    const dspCount = activeDsps(form).length;

    const parts: string[] = [];
    if (uniqueSsps) parts.push(`${uniqueSsps} SSP${uniqueSsps !== 1 ? 's' : ''}`);
    if (uniqueChannels) parts.push(`${uniqueChannels} Channel${uniqueChannels !== 1 ? 's' : ''}`);
    if (dspCount > 1) parts.push(`${dspCount} DSPs`);
    const totalExpanded = items.length;
    const formula = `${totalExpanded} Deal${totalExpanded !== 1 ? 's' : ''}${parts.length ? ' (' + parts.join(' × ') + ')' : ''}`;

    return {
      totalDeals: totalExpanded,
      formula,
      dealNames: names,
      items,
      sspCounts: tally(items.map(i => i.sspCode)),
      channelCounts: tally(items.map(i => i.channel)),
    };
  }, [form]);
}
