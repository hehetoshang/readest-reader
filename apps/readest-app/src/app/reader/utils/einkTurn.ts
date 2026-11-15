/** The host's display mode also applies when a book has older saved settings. */
export const isReaderEink = (
  settings: { isEink?: boolean },
  hostEink = typeof window !== 'undefined' && window.__MOKE_EINK === true,
): boolean => hostEink || settings.isEink === true;

export const applyEinkTurnAttributes = (
  renderer: Pick<Element, 'setAttribute' | 'removeAttribute'>,
  settings: { isEink?: boolean; animated?: boolean },
) => {
  const eink = isReaderEink(settings);
  if (settings.animated && !eink) renderer.setAttribute('animated', '');
  else renderer.removeAttribute('animated');
  if (eink) renderer.setAttribute('eink', '');
  else renderer.removeAttribute('eink');
};
