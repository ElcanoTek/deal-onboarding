// Demo / smoke-test fixtures for the parser modal. Every advertiser, agency,
// person, id, and segment below is fictional. The multi-deal brief exercises
// the parser's corner cases: several deals across two SSPs, per-deal
// targeting tables, and explicit deal names.
export interface SampleBrief {
  id: string
  label: string
  description: string
  text: string
}

export const SAMPLE_BRIEFS: SampleBrief[] = [
  {
    id: 'northwind-weather-8',
    label: 'Northwind Outdoors · 8 deals (IX + Magnite)',
    description: 'Multi-deal brief covering 4 audience themes × 2 SSPs with per-deal segment tables.',
    text: `Northwind Outdoors Deal Setup Reference

This document outlines the setup details and targeting segments for the 8 Northwind Outdoors deals across Index Exchange and Magnite.

1. General Campaign Information

Field | Value
Advertiser | Northwind Outdoors
Flight Dates | 5/4/2026 – 12/31/2026
DSP | The Trade Desk
Seat ID | 2968
Channel | Display
Inventory Type | All
Campaign ID | DEAL00145
Sales Person: Sam Rivera
Submitter: planner@example.com
Agency: Two by Four
Bid floor: 0.10

2. Deals Overview

Deal Name | Platform | Theme
Curator_Index_TTD_Two by Four_Northwind Outdoors_NA_Rain_Display_All_US_DEAL00145_B14 | Index | Rain
Curator_Magnite_TTD_Two by Four_Northwind Outdoors_NA_Rain_Display_All_US_DEAL00145_B14 | Magnite | Rain
Curator_Index_TTD_Two by Four_Northwind Outdoors_NA_Sunny_Display_All_US_DEAL00145_B14 | Index | Sunny
Curator_Magnite_TTD_Two by Four_Northwind Outdoors_NA_Sunny_Display_All_US_DEAL00145_B14 | Magnite | Sunny
Curator_Index_TTD_Two by Four_Northwind Outdoors_NA_Warm Weekend_Display_All_US_DEAL00145_B14 | Index | Warm Weekend
Curator_Magnite_TTD_Two by Four_Northwind Outdoors_NA_Warm Weekend_Display_All_US_DEAL00145_B14 | Magnite | Warm Weekend
Curator_Index_TTD_Two by Four_Northwind Outdoors_NA_Hot_Display_All_US_DEAL00145_B14 | Index | Hot Weather
Curator_Magnite_TTD_Two by Four_Northwind Outdoors_NA_Hot_Display_All_US_DEAL00145_B14 | Magnite | Hot Weather

3. Detailed Deal Targeting

Deal 1: Index - Rain
194 - DataCo > Weather Targeting > Relative > Current > Light Rain
225 - DataCo > Weather Targeting > Relative > Forecast > Light Rain
1000 - DataCo > Weather Targeting > Absolute > Current > Historical and Current Rain
190 - DataCo > Weather Targeting > Absolute > Forecast > Rain

Deal 2: Magnite - Rain
194 - DataCo > Weather Targeting > Relative > Current > Light Rain
225 - DataCo > Weather Targeting > Relative > Forecast > Light Rain
1000 - DataCo > Weather Targeting > Absolute > Current > Historical and Current Rain
190 - DataCo > Weather Targeting > Absolute > Forecast > Rain

Deal 3: Index - Sunny
310 - DataCo > Weather Targeting > Absolute > Current > Sunny
311 - DataCo > Weather Targeting > Absolute > Forecast > Sunny

Deal 4: Magnite - Sunny
310 - DataCo > Weather Targeting > Absolute > Current > Sunny
311 - DataCo > Weather Targeting > Absolute > Forecast > Sunny

Deal 5: Index - Warm Weekend
420 - DataCo > Weather Targeting > Relative > Forecast > Warm Weekend

Deal 6: Magnite - Warm Weekend
420 - DataCo > Weather Targeting > Relative > Forecast > Warm Weekend

Deal 7: Index - Hot Weather
530 - DataCo > Weather Targeting > Absolute > Current > Hot
531 - DataCo > Weather Targeting > Absolute > Forecast > Hot

Deal 8: Magnite - Hot Weather
530 - DataCo > Weather Targeting > Absolute > Current > Hot
531 - DataCo > Weather Targeting > Absolute > Forecast > Hot

4. Notes

Attribution code B14. Curated deal fee 15% of media. Geo: United States only.
Deal sheet recipient: trader@example.com
`,
  },
  {
    id: 'contoso-ctv-2',
    label: 'Contoso Coffee · 2 CTV deals (OpenX + PubMatic)',
    description: 'A short email-style brief with one audience on two SSPs.',
    text: `Hi team — please set up the Contoso Coffee Q4 CTV push.

Advertiser: Contoso Coffee
Agency: Fabrikam Media
DSP: DV360, seat 1234567
Campaign ID: DEAL00212
Flight: 10/1/2026 – 12/15/2026
Channel: CTV, all inventory
SSPs: OpenX and PubMatic
Audience: Coffee Enthusiasts (DataCo segment 8812)
Floor: $18 CPM, VCR target 90%
Curated deal fee: 12% of media
Geo: US
Attribution: A1
Send the deal sheet to trader@example.com.
`,
  },
]
