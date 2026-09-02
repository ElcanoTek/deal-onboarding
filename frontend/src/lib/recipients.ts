/** Deal-sheet recipient list handling.
 *
 *  FormData.dealSheetRecipient stays a plain comma-joined string on the wire
 *  (drafts persisted before multi-recipient existed hydrate unchanged; the
 *  audit request shape is unchanged). The chip input, validators, and the
 *  prompt/brief builders all split it through here.
 *
 *  Downstream contract: the FIRST address is the deal-sheet email's To
 *  (`recipient` in the brief, `to_email` in the followup_step) — the
 *  protocol's single-trader contract — and every additional address rides
 *  the schema-blessed cc list (`cc_recipients` / `cc_emails`). The
 *  separators match what cutlass's sendgrid server tolerates.
 */
export function splitEmails(raw: string): string[] {
  return raw.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)
}
