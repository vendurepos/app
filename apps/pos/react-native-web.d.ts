import 'react-native';

declare module 'react-native' {
  interface ViewProps {
    // react-native-web turns each entry into a data-* DOM attribute ({ print: 'hide' } → data-print="hide"), which
    // TallyUI's injectPrintStyle() hides when printing; its own ViewProps carry the same declaration.
    dataSet?: { [key: string]: string | number };
  }
}
