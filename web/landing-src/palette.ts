/* The landing palette.
 *
 * Verified before use, because three earlier palettes in this project
 * shipped a grey that could not be read. Against both surfaces (#05070A and
 * #0D1117) every text token here clears 4.5:1 — muted is the tightest at
 * 7.4:1, which is comfortable.
 *
 * On the accent fills, dark ink is the only option: white on cyan is
 * 1.77:1 and white on blue is 3.26:1, both unusable for a button label.
 *
 * NOTE: this is a DIFFERENT palette from the console, which runs on
 * petroleum graphite and oil green. That is deliberate per the brief, but
 * it does mean the public site and the product no longer share a look —
 * worth resolving in one direction or the other before this is shown as
 * one product.
 */
export const PALETTE = {
  bg: '#05070A',
  panel: '#0D1117',
  cyan: '#00D4FF',     // 11.4:1 on bg
  blue: '#3A8DFF',     //  6.2:1
  warn: '#FF8A00',     //  8.5:1
  critical: '#FF4D4D', //  6.2:1
  success: '#2ECC71',  //  9.6:1
  text: '#E8EEF5',     // 17.3:1
  muted: '#94A3B8',    //  7.9:1
  /** Ink for text sitting ON an accent fill. */
  onAccent: '#05070A',
} as const;

/** Steel, for the pipe bodies. Neutral on purpose: an earlier version of
 *  this component tinted the steel toward the accent and the result read as
 *  painted plastic rather than metal. */
export const STEEL = {
  dark: '#2A3340',
  light: '#8C9AAC',
  rust: '#8A4A1E',
} as const;
