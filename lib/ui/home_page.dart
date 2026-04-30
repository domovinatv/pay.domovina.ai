import 'package:barcode_widget/barcode_widget.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../models/eip681_payload.dart';
import '../models/epc_payload.dart';
import '../models/hub3_payload.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  final _name = TextEditingController(text: 'ITalk d.o.o.');
  final _address = TextEditingController(text: 'IX. Južna obala 20');
  final _city = TextEditingController(text: 'Zagreb');
  final _amount = TextEditingController(text: '1.01');
  final _description = TextEditingController(
      text: 'gnosis:0xb2AF1Dc5A6290C3B9c69C486014203C823bD7A9c');

  final _hrIban = TextEditingController(text: 'HR6023900011500157044');
  final _model = TextEditingController(text: 'HR00');
  final _reference = TextEditingController(text: '1991');

  final _eeIban = TextEditingController(text: 'EE707777000162921128');
  final _bic = TextEditingController(text: 'LHVBEE22');
  final _epcPurpose = TextEditingController(text: 'OTHR');
  final _epcRemittance = TextEditingController(
      text: 'gnosis:0xb2AF1Dc5A6290C3B9c69C486014203C823bD7A9c');

  final _walletChainId = TextEditingController(text: '100');
  final _walletTokenContract = TextEditingController(
      text: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430');
  final _walletTokenDecimals = TextEditingController(text: '18');

  List<TextEditingController> get _allControllers => [
        _name, _address, _city, _amount, _description,
        _hrIban, _model, _reference,
        _eeIban, _bic, _epcPurpose, _epcRemittance,
        _walletChainId, _walletTokenContract, _walletTokenDecimals,
      ];

  @override
  void initState() {
    super.initState();
    for (final c in _allControllers) {
      c.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    for (final c in _allControllers) {
      c.dispose();
    }
    super.dispose();
  }

  double get _amountValue =>
      double.tryParse(_amount.text.replaceAll(',', '.')) ?? 0;

  String get _epcData => EpcPayload(
        bic: _bic.text.trim(),
        name: _name.text.trim(),
        iban: _eeIban.text.trim(),
        amount: _amountValue > 0 ? _amountValue : null,
        purposeCode: _epcPurpose.text.trim(),
        remittanceInfo: _epcRemittance.text.trim(),
      ).build();

  String get _hub3Data => Hub3Payload(
        amount: _amountValue,
        name: _name.text.trim(),
        address: _address.text.trim(),
        city: _city.text.trim(),
        iban: _hrIban.text.trim(),
        model: _model.text.trim(),
        reference: _reference.text.trim(),
        description: _description.text.trim(),
      ).build();

  /// Strip optional chain prefix like "gnosis:" from remittance to get raw 0x address.
  String get _walletRecipient {
    final r = _epcRemittance.text.trim();
    final colon = r.indexOf(':');
    return colon >= 0 ? r.substring(colon + 1).trim() : r;
  }

  String get _walletData => EipPayload(
        recipient: _walletRecipient,
        chainId: int.tryParse(_walletChainId.text.trim()) ?? 100,
        amount: _amountValue > 0 ? _amountValue : null,
        tokenContract: _walletTokenContract.text.trim(),
        tokenDecimals: int.tryParse(_walletTokenDecimals.text.trim()) ?? 18,
      ).build();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('pay.domovina.ai — SEPA / HUB3 generator'),
      ),
      body: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 900;
          final form = _buildForm();
          final preview = LayoutBuilder(
            builder: (_, c) => _buildPreview(c),
          );
          return wide
              ? Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 420,
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(16),
                        child: form,
                      ),
                    ),
                    const VerticalDivider(width: 1),
                    Expanded(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(16),
                        child: preview,
                      ),
                    ),
                  ],
                )
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(16),
                  child: Column(children: [form, const SizedBox(height: 24), preview]),
                );
        },
      ),
    );
  }

  Widget _buildForm() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _section('Zajedničko'),
        _field(_name, 'Naziv primatelja'),
        _field(_address, 'Adresa'),
        _field(_city, 'Grad'),
        _field(_amount, 'Iznos (EUR)'),
        const SizedBox(height: 16),
        _section('HUB3 (Hrvatska — PDF417)'),
        _field(_hrIban, 'HR IBAN'),
        _field(_model, 'Model'),
        _field(_reference, 'Poziv na broj'),
        _field(_description, 'Opis plaćanja'),
        const SizedBox(height: 16),
        _section('EPC QR (SEPA / Monerium)'),
        _field(_eeIban, 'IBAN (EUR)'),
        _field(_bic, 'BIC'),
        _field(_epcPurpose, 'Purpose code (4 znaka, npr. OTHR / DONA / SALA)'),
        _field(_epcRemittance, 'Remittance info (npr. gnosis:0x…)'),
        const SizedBox(height: 16),
        _section('Wallet QR (EIP-681 — MetaMask itd.)'),
        _field(_walletChainId, 'Chain ID (100 = Gnosis, 1 = Mainnet)'),
        _field(_walletTokenContract,
            'Token contract (prazno = native; default EURe Gnosis)'),
        _field(_walletTokenDecimals, 'Token decimals'),
      ],
    );
  }

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.only(bottom: 8, top: 4),
        child: Text(title,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      );

  Widget _field(TextEditingController c, String label) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: TextField(
          controller: c,
          decoration: InputDecoration(
            labelText: label,
            border: const OutlineInputBorder(),
            isDense: true,
          ),
        ),
      );

  Widget _qrPreview(String data) {
    return RepaintBoundary(
      child: Container(
        color: Colors.white,
        padding: const EdgeInsets.all(24),
        child: SizedBox(
          width: 320,
          height: 320,
          child: FittedBox(
            fit: BoxFit.contain,
            child: SizedBox(
              width: 1280,
              height: 1280,
              child: QrImageView(
                data: data,
                version: QrVersions.auto,
                size: 1280,
                padding: EdgeInsets.zero,
                backgroundColor: Colors.white,
                errorCorrectionLevel: QrErrorCorrectLevel.M,
                gapless: true,
                eyeStyle: const QrEyeStyle(
                  eyeShape: QrEyeShape.square,
                  color: Colors.black,
                ),
                dataModuleStyle: const QrDataModuleStyle(
                  dataModuleShape: QrDataModuleShape.square,
                  color: Colors.black,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildPreview(BoxConstraints constraints) {
    final epcCard = _previewCard(
      title: 'EPC QR (SEPA Credit Transfer)',
      subtitle: 'Skeniraj u Revolut / banci za SEPA plaćanje',
      barcode: Center(child: _qrPreview(_epcData)),
      rawData: _epcData,
    );

    final walletCard = _previewCard(
      title: 'Wallet QR (EIP-681)',
      subtitle: 'Skeniraj u MetaMask / Rainbow / Coinbase Wallet',
      barcode: Center(child: _qrPreview(_walletData)),
      rawData: _walletData,
    );

    final hub3Card = _previewCard(
      title: 'HUB3 (PDF417)',
      subtitle: 'Skeniraj u hrvatskoj mobilnoj bankarskoj aplikaciji',
      barcode: Center(
        child: SizedBox(
          height: 110,
          width: 420,
          child: BarcodeWidget(
            data: _hub3Data,
            barcode: Barcode.pdf417(
              moduleHeight: 2,
              preferredRatio: 3,
            ),
            drawText: false,
            backgroundColor: Colors.white,
          ),
        ),
      ),
      rawData: _hub3Data,
    );

    final wide = constraints.maxWidth >= 700;
    return wide
        ? Flex(
            direction: Axis.horizontal,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: epcCard),
              const SizedBox(width: 16),
              Expanded(child: walletCard),
              const SizedBox(width: 16),
              Expanded(child: hub3Card),
            ],
          )
        : Flex(
            direction: Axis.vertical,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              epcCard,
              const SizedBox(height: 24),
              walletCard,
              const SizedBox(height: 24),
              hub3Card,
            ],
          );
  }

  Widget _previewCard({
    required String title,
    required String subtitle,
    required Widget barcode,
    required String rawData,
  }) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title,
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(subtitle, style: TextStyle(color: Colors.grey[700])),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(16),
              color: Colors.white,
              child: barcode,
            ),
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.grey[100],
                borderRadius: BorderRadius.circular(6),
              ),
              child: SelectableText(
                rawData,
                style: const TextStyle(
                    fontFamily: 'Menlo', fontSize: 12, height: 1.4),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
