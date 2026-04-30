import 'package:flutter/material.dart';

import 'ui/home_page.dart';

void main() => runApp(const PayApp());

class PayApp extends StatelessWidget {
  const PayApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'pay.domovina.ai',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF0B6BCB),
      ),
      home: const HomePage(),
    );
  }
}
