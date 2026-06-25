/**
 * Inline brand wordmark for body copy: renders "tribelife" lowercase and a touch
 * bolder than the surrounding text. The DOM keeps the proper-cased "TribeLife"
 * (lowercasing is presentational) so copy/paste and screen readers stay correct.
 */
const Brand = () => <span className="lowercase font-semibold">TribeLife</span>;

export default Brand;
