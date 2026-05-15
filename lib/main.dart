import 'package:flutter/material.dart';

import 'ui/home_page.dart';

class DomovinaBrand {
  static const navy = Color(0xFF002F6C);
  static const red = Color(0xFFFF0000);
  static const white = Color(0xFFFFFFFF);
  static const muted = Color(0xFF5A6570);
  static const border = Color(0xFFE1E5EA);
  static const surface = Color(0xFFF5F7F9);
}

void main() => runApp(const PayApp());

class PayApp extends StatelessWidget {
  const PayApp({super.key});

  @override
  Widget build(BuildContext context) {
    final colorScheme = const ColorScheme.light(
      primary: DomovinaBrand.navy,
      onPrimary: DomovinaBrand.white,
      secondary: DomovinaBrand.red,
      onSecondary: DomovinaBrand.white,
      surface: DomovinaBrand.white,
      onSurface: DomovinaBrand.navy,
      surfaceContainerHighest: DomovinaBrand.surface,
      outline: DomovinaBrand.border,
      outlineVariant: DomovinaBrand.border,
    );

    return MaterialApp(
      title: 'pay.domovina.ai',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: colorScheme,
        scaffoldBackgroundColor: DomovinaBrand.white,
        fontFamily: 'system-ui',
        textTheme: const TextTheme().apply(
          bodyColor: DomovinaBrand.navy,
          displayColor: DomovinaBrand.navy,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: DomovinaBrand.navy,
          foregroundColor: DomovinaBrand.white,
          elevation: 0,
          centerTitle: false,
          titleTextStyle: TextStyle(
            color: DomovinaBrand.white,
            fontSize: 18,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.5,
          ),
        ),
        tabBarTheme: const TabBarThemeData(
          labelColor: DomovinaBrand.white,
          unselectedLabelColor: Color(0xCCFFFFFF),
          indicatorColor: DomovinaBrand.red,
          indicatorSize: TabBarIndicatorSize.tab,
          labelStyle: TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
          unselectedLabelStyle:
              TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
        ),
        cardTheme: CardThemeData(
          color: DomovinaBrand.white,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
            side: const BorderSide(color: DomovinaBrand.border),
          ),
        ),
        inputDecorationTheme: InputDecorationTheme(
          isDense: true,
          filled: true,
          fillColor: DomovinaBrand.white,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: DomovinaBrand.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide: const BorderSide(color: DomovinaBrand.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(8),
            borderSide:
                const BorderSide(color: DomovinaBrand.navy, width: 1.5),
          ),
          labelStyle: const TextStyle(color: DomovinaBrand.muted),
          helperStyle: const TextStyle(color: DomovinaBrand.muted),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            foregroundColor: DomovinaBrand.navy,
            side: const BorderSide(color: DomovinaBrand.border),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8),
            ),
            padding:
                const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          ),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: DomovinaBrand.navy,
            foregroundColor: DomovinaBrand.white,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8),
            ),
          ),
        ),
        dividerTheme: const DividerThemeData(
          color: DomovinaBrand.border,
          thickness: 1,
        ),
      ),
      home: const HomePage(),
    );
  }
}
