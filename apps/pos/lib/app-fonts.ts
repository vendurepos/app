import { THEME_FONT_FAMILIES, type ThemeFontFamily } from '@tallyui/theme';
import { Asset } from 'expo-asset';
import * as Font from 'expo-font';
import { Platform } from 'react-native';
import { createFontLoader, type FontFaceSource } from './font-loader';

export const FONT_SOURCES: Record<ThemeFontFamily, readonly FontFaceSource[]> = {
  'DM Sans': [{ weight: 400, asset: require('@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf') },
    { weight: 500, asset: require('@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf') },
    { weight: 600, asset: require('@expo-google-fonts/dm-sans/600SemiBold/DMSans_600SemiBold.ttf') },
    { weight: 700, asset: require('@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf') }],
  'Instrument Serif': [{ weight: 400, asset: require('@expo-google-fonts/instrument-serif/400Regular/InstrumentSerif_400Regular.ttf') },
    { weight: 400, style: 'italic', asset: require('@expo-google-fonts/instrument-serif/400Regular_Italic/InstrumentSerif_400Regular_Italic.ttf') }],
  'JetBrains Mono': [{ weight: 400, asset: require('@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf') },
    { weight: 500, asset: require('@expo-google-fonts/jetbrains-mono/500Medium/JetBrainsMono_500Medium.ttf') },
    { weight: 600, asset: require('@expo-google-fonts/jetbrains-mono/600SemiBold/JetBrainsMono_600SemiBold.ttf') }],
  'Space Grotesk': [{ weight: 500, asset: require('@expo-google-fonts/space-grotesk/500Medium/SpaceGrotesk_500Medium.ttf') },
    { weight: 600, asset: require('@expo-google-fonts/space-grotesk/600SemiBold/SpaceGrotesk_600SemiBold.ttf') },
    { weight: 700, asset: require('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf') }],
  Fraunces: [{ weight: 500, asset: require('@expo-google-fonts/fraunces/500Medium/Fraunces_500Medium.ttf') },
    { weight: 600, asset: require('@expo-google-fonts/fraunces/600SemiBold/Fraunces_600SemiBold.ttf') },
    { weight: 500, style: 'italic', asset: require('@expo-google-fonts/fraunces/500Medium_Italic/Fraunces_500Medium_Italic.ttf') },
    { weight: 600, style: 'italic', asset: require('@expo-google-fonts/fraunces/600SemiBold_Italic/Fraunces_600SemiBold_Italic.ttf') }],
  Manrope: [{ weight: 500, asset: require('@expo-google-fonts/manrope/500Medium/Manrope_500Medium.ttf') },
    { weight: 600, asset: require('@expo-google-fonts/manrope/600SemiBold/Manrope_600SemiBold.ttf') },
    { weight: 700, asset: require('@expo-google-fonts/manrope/700Bold/Manrope_700Bold.ttf') },
    { weight: 800, asset: require('@expo-google-fonts/manrope/800ExtraBold/Manrope_800ExtraBold.ttf') }],
};
export const ALL_FONT_FAMILIES = Object.values(THEME_FONT_FAMILIES);
export const loadAppFonts = createFontLoader({
  faces: FONT_SOURCES, web: Platform.OS === 'web',
  addWebFace: async (family, { asset, weight, style }) => {
    const uri = Asset.fromModule(asset as number).uri;
    const face = new FontFace(family, `url("${uri}")`, { weight: String(weight), style: style ?? 'normal', display: 'swap' });
    await face.load();
    document.fonts.add(face);
  },
  loadNative: Font.loadAsync as (fonts: Record<string, unknown>) => Promise<void>,
});
