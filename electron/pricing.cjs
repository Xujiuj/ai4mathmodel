// Pricing table for common model providers, indexed by protocol + model prefix.
// Units: CNY per million tokens (input / output / cache-read).
// When no match is found the cost is marked as unknown, not defaulted to zero.
const BUILTIN_PRICING = Object.freeze({
  // Anthropic (官方定价 × 7.3 汇率)
  'anthropic:claude-opus': [109.5, 547.5, 10.95],
  'anthropic:claude-sonnet-4': [21.9, 109.5, 2.19],
  'anthropic:claude-sonnet-3-5': [21.9, 109.5, 2.19],
  'anthropic:claude-haiku': [5.84, 29.2, 0.584],

  // OpenAI (官方定价 × 7.3 汇率)
  'openai:gpt-4o': [18.25, 54.75, 9.125],
  'openai:gpt-4o-mini': [1.095, 3.285, 0.5475],
  'openai:o1': [109.5, 438.0, 54.75],
  'openai:o1-mini': [21.9, 87.6, 10.95],
  'openai:gpt-4-turbo': [73.0, 219.0, 0],
  'openai:gpt-3.5-turbo': [3.65, 10.95, 0],

  // Ollama 本地模型计为零元(但仍计 token 数)
  'ollama:': [0, 0, 0],
});

/**
 * Resolves pricing for a given protocol and model. Returns [inputPrice, outputPrice, cachePrice]
 * in CNY per million tokens, or null when no built-in rule matches and no user override exists.
 * @param {string} protocol - 'anthropic', 'openai', or 'ollama'
 * @param {string} model - Full model identifier (e.g., 'claude-opus-4')
 * @param {Object} [overrides={}] - User-provided per-connection pricing overrides
 * @returns {[number, number, number] | null}
 */
function resolvePricing(protocol, model, overrides = {}) {
  const key = `${protocol}:${model}`;

  // User override takes precedence
  if (overrides[key]) {
    const [input, output, cache = 0] = overrides[key];
    if (typeof input === 'number' && typeof output === 'number') {
      return [input, output, typeof cache === 'number' ? cache : 0];
    }
  }

  // Prefix match against built-in table (longest match wins)
  const candidates = Object.keys(BUILTIN_PRICING).filter((prefix) => key.startsWith(prefix));
  if (!candidates.length) return null;
  const longest = candidates.reduce((a, b) => (a.length > b.length ? a : b));
  return BUILTIN_PRICING[longest];
}

/**
 * Computes the cost in CNY for a given usage object.
 * @param {Object} usage - { inputTokens, outputTokens, cacheReadTokens }
 * @param {string} protocol
 * @param {string} model
 * @param {Object} [overrides={}]
 * @returns {{ cost: number, pricingUnknown: boolean }}
 */
function computeCost(usage, protocol, model, overrides = {}) {
  const pricing = resolvePricing(protocol, model, overrides);
  if (!pricing) return { cost: 0, pricingUnknown: true };

  const [inputPrice, outputPrice, cachePrice] = pricing;
  const input = Number(usage?.inputTokens || 0) / 1_000_000;
  const output = Number(usage?.outputTokens || 0) / 1_000_000;
  const cache = Number(usage?.cacheReadTokens || 0) / 1_000_000;

  return {
    cost: input * inputPrice + output * outputPrice + cache * cachePrice,
    pricingUnknown: false,
  };
}

module.exports = {
  BUILTIN_PRICING,
  resolvePricing,
  computeCost,
};
