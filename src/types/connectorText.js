export default {};
export function isConnectorTextBlock(block) {
  return !!block && typeof block === 'object' && block.type === 'connector_text';
}
