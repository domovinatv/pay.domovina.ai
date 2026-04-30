import 'package:flutter/material.dart';

class HpbHistoryPage extends StatelessWidget {
  final String iban;

  const HpbHistoryPage({super.key, required this.iban});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.account_balance,
                            size: 28, color: Colors.grey),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('HPB IBAN',
                                  style: TextStyle(
                                      fontSize: 18,
                                      fontWeight: FontWeight.w600)),
                              const SizedBox(height: 2),
                              Text(iban,
                                  style: TextStyle(
                                      fontFamily: 'Menlo',
                                      fontSize: 13,
                                      color: Colors.grey[700])),
                            ],
                          ),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(
                              horizontal: 10, vertical: 4),
                          decoration: BoxDecoration(
                            color: Colors.amber[100],
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: Text('USKORO',
                              style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: FontWeight.w700,
                                  color: Colors.amber[900])),
                        ),
                      ],
                    ),
                    const Divider(height: 32),
                    Text(
                      'Pregled transakcija s hrvatskog HPB računa.',
                      style: TextStyle(
                          fontSize: 15, color: Colors.grey[800]),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      'Za dohvat povijesti uplata i isplata potreban je '
                      'PSD2 Open Banking pristup preko HPB-ovog AISP API-ja '
                      '(s certifikatom i odobrenom registracijom kod HNB-a) '
                      'ili agregatorskog servisa. Ovaj dio zahtijeva backend '
                      'komponentu i još nije implementiran.',
                      style: TextStyle(
                          fontSize: 14,
                          color: Colors.grey[700],
                          height: 1.5),
                    ),
                    const SizedBox(height: 20),
                    _bullet('Autentikacija krajnjeg korisnika kroz HPB SCA'),
                    _bullet('Dohvat liste računa (`accounts`)'),
                    _bullet('Dohvat transakcija (`transactions`)'),
                    _bullet('Mapiranje na isti UI kao Gnosis EURe pregled'),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _bullet(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 6, right: 8),
              child: Icon(Icons.circle, size: 6, color: Colors.grey),
            ),
            Expanded(
                child: Text(text,
                    style:
                        TextStyle(fontSize: 13, color: Colors.grey[700]))),
          ],
        ),
      );
}
