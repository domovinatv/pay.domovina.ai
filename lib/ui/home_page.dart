import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:barcode/barcode.dart' as bc;
import 'package:barcode_widget/barcode_widget.dart';
import 'package:file_saver/file_saver.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../models/eip681_payload.dart';
import '../models/epc_payload.dart';
import '../models/hub3_payload.dart';
import 'gnosis_history_page.dart';
import 'hpb_history_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  static final _addressRegex = RegExp(r'^0x[0-9a-fA-F]{40}$');

  static const _epcColor = Color(0xFF1565C0);      // SEPA banking blue
  static const _hub3Color = Color(0xFFC62828);     // Croatian red
  static const _walletColor = Color(0xFF6A1B9A);   // Web3 purple

  final _name = TextEditingController(text: 'ITalk d.o.o.');
  final _address = TextEditingController(text: 'IX. Južna obala 20');
  final _city = TextEditingController(text: 'Zagreb');
  final _amount = TextEditingController(text: '1.01');

  final _gnosisAddress = TextEditingController(
      text: '0x6693a7D19486Dc45e9F90Fd2D515d972bBA2d65e');

  final _epcCaptureKey = GlobalKey();
  final _hub3CaptureKey = GlobalKey();
  final _walletCaptureKey = GlobalKey();

  final _hrIban = TextEditingController(text: 'HR6023900011500157044');
  final _model = TextEditingController(text: 'HR00');
  final _reference = TextEditingController(text: '1991');

  final _eeIban = TextEditingController(text: 'EE707777000162921128');
  final _bic = TextEditingController(text: 'LHVBEE22');
  final _epcPurpose = TextEditingController(text: 'OTHR');

  final _walletChainId = TextEditingController(text: '100');
  final _walletTokenContract = TextEditingController(
      text: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430');
  final _walletTokenDecimals = TextEditingController(text: '18');

  List<TextEditingController> get _allControllers => [
        _name, _address, _city, _amount, _gnosisAddress,
        _hrIban, _model, _reference,
        _eeIban, _bic, _epcPurpose,
        _walletChainId, _walletTokenContract, _walletTokenDecimals,
      ];

  String get _gnosisAddr => _gnosisAddress.text.trim();
  bool get _isValidGnosisAddress => _addressRegex.hasMatch(_gnosisAddr);
  String get _gnosisRemittance => 'gnosis:$_gnosisAddr';

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
        remittanceInfo: _gnosisRemittance,
      ).build();

  String get _hub3Data => Hub3Payload(
        amount: _amountValue,
        name: _name.text.trim(),
        address: _address.text.trim(),
        city: _city.text.trim(),
        iban: _hrIban.text.trim(),
        model: _model.text.trim(),
        reference: _reference.text.trim(),
        description: _gnosisRemittance,
      ).build();

  String get _walletData => EipPayload(
        recipient: _gnosisAddr,
        chainId: int.tryParse(_walletChainId.text.trim()) ?? 100,
        amount: _amountValue > 0 ? _amountValue : null,
        tokenContract: _walletTokenContract.text.trim(),
        tokenDecimals: int.tryParse(_walletTokenDecimals.text.trim()) ?? 18,
      ).build();

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('pay.domovina.ai'),
          bottom: const TabBar(
            tabs: [
              Tab(icon: Icon(Icons.qr_code_2), text: 'Generator barkoda'),
              Tab(icon: Icon(Icons.account_balance_wallet), text: 'Gnosis EURe'),
              Tab(icon: Icon(Icons.account_balance), text: 'HPB IBAN'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _buildGeneratorTab(),
            _isValidGnosisAddress
                ? GnosisHistoryPage(
                    key: ValueKey(
                        '${_gnosisAddr}_${_walletTokenContract.text.trim()}'),
                    address: _gnosisAddr,
                    tokenContract: _walletTokenContract.text.trim(),
                    decimals:
                        int.tryParse(_walletTokenDecimals.text.trim()) ?? 18,
                    symbol: 'EURe',
                  )
                : _invalidAddressPlaceholder(),
            HpbHistoryPage(iban: _hrIban.text.trim()),
          ],
        ),
      ),
    );
  }

  Widget _buildGeneratorTab() {
    return LayoutBuilder(
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
                child: Column(
                    children: [form, const SizedBox(height: 24), preview]),
              );
      },
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
        _field(
          _gnosisAddress,
          'Gnosis adresa primatelja (0x…)',
          helper: _isValidGnosisAddress
              ? 'Remittance / opis: $_gnosisRemittance'
              : 'Mora biti validna 0x adresa (40 hex znakova)',
          errorText: _isValidGnosisAddress
              ? null
              : 'Nevažeća adresa',
        ),
        const SizedBox(height: 20),
        _section('1. EPC QR (SEPA / Monerium)',
            color: _epcColor, icon: Icons.qr_code_2),
        _field(_eeIban, 'IBAN (EUR)'),
        _field(_bic, 'BIC'),
        _field(_epcPurpose, 'Purpose code (4 znaka, npr. OTHR / DONA / SALA)'),
        const SizedBox(height: 20),
        _section('2. HUB3 (Hrvatska — PDF417)',
            color: _hub3Color, icon: Icons.view_week),
        _field(_hrIban, 'HR IBAN'),
        _field(_model, 'Model'),
        _field(_reference, 'Poziv na broj'),
        const SizedBox(height: 20),
        _section('3. Wallet QR (EIP-681 — MetaMask)',
            color: _walletColor, icon: Icons.account_balance_wallet),
        _field(_walletChainId, 'Chain ID (100 = Gnosis, 1 = Mainnet)'),
        _field(_walletTokenContract,
            'Token contract (prazno = native; default EURe Gnosis)'),
        _field(_walletTokenDecimals, 'Token decimals'),
      ],
    );
  }

  Widget _invalidAddressPlaceholder() {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.warning_amber_rounded,
                  size: 48, color: Colors.amber[700]),
              const SizedBox(height: 16),
              const Text(
                'Unesi validnu Gnosis adresu',
                style:
                    TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              Text(
                'Pregled on-chain transakcija zahtijeva ispravnu 0x adresu '
                '(40 hex znakova). Otvori tab "Generator barkoda" i ispravi '
                'polje "Gnosis adresa primatelja".',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.grey[700], height: 1.5),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _section(String title, {Color? color, IconData? icon}) => Padding(
        padding: const EdgeInsets.only(bottom: 10, top: 4),
        child: Row(
          children: [
            if (icon != null) ...[
              Icon(icon, size: 20, color: color),
              const SizedBox(width: 8),
            ],
            Text(
              title,
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: color,
                letterSpacing: 0.2,
              ),
            ),
          ],
        ),
      );

  Widget _field(
    TextEditingController c,
    String label, {
    String? helper,
    String? errorText,
  }) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: TextField(
          controller: c,
          decoration: InputDecoration(
            labelText: label,
            border: const OutlineInputBorder(),
            isDense: true,
            helperText: helper,
            helperMaxLines: 2,
            errorText: errorText,
          ),
        ),
      );

  Widget _qrPreview(String data, GlobalKey captureKey) {
    return RepaintBoundary(
      key: captureKey,
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

  Widget _pdf417Preview(String data, GlobalKey captureKey) {
    return RepaintBoundary(
      key: captureKey,
      child: Container(
        color: Colors.white,
        padding: const EdgeInsets.all(16),
        child: SizedBox(
          height: 110,
          width: 420,
          child: BarcodeWidget(
            data: data,
            barcode: Barcode.pdf417(
              moduleHeight: 2,
              preferredRatio: 3,
            ),
            drawText: false,
            backgroundColor: Colors.white,
          ),
        ),
      ),
    );
  }

  String _qrSvg(String data) =>
      bc.Barcode.qrCode(errorCorrectLevel: bc.BarcodeQRCorrectionLevel.medium)
          .toSvg(data, width: 1024, height: 1024);

  String _pdf417Svg(String data) => bc.Barcode.pdf417(
        moduleHeight: 2,
        preferredRatio: 3,
      ).toSvg(data, width: 1680, height: 440);

  Future<Uint8List> _capturePng(GlobalKey key,
      {double pixelRatio = 6}) async {
    final ctx = key.currentContext;
    if (ctx == null) {
      throw StateError('Barcode nije renderiran');
    }
    final boundary = ctx.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: pixelRatio);
    final byteData =
        await image.toByteData(format: ui.ImageByteFormat.png);
    if (byteData == null) {
      throw StateError('PNG enkodiranje nije uspjelo');
    }
    return byteData.buffer.asUint8List();
  }

  Future<void> _saveSvg(String filename, String svg) async {
    await FileSaver.instance.saveFile(
      name: filename,
      bytes: Uint8List.fromList(utf8.encode(svg)),
      ext: 'svg',
      mimeType: MimeType.other,
    );
  }

  Future<void> _savePng(String filename, Uint8List bytes) async {
    await FileSaver.instance.saveFile(
      name: filename,
      bytes: bytes,
      ext: 'png',
      mimeType: MimeType.png,
    );
  }

  Future<void> _handleDownload({
    required Future<void> Function() action,
    required String successMessage,
  }) async {
    try {
      await action();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(successMessage)),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Greška pri spremanju: $e')),
      );
    }
  }

  Widget _buildPreview(BoxConstraints constraints) {
    final epcCard = _previewCard(
      index: 1,
      title: 'EPC QR (SEPA Credit Transfer)',
      subtitle: 'Skeniraj u Revolut / banci za SEPA plaćanje',
      accent: _epcColor,
      icon: Icons.qr_code_2,
      barcode: Center(child: _qrPreview(_epcData, _epcCaptureKey)),
      rawData: _epcData,
      baseFilename: 'epc-qr',
      captureKey: _epcCaptureKey,
      svgBuilder: () => _qrSvg(_epcData),
    );

    final hub3Card = _previewCard(
      index: 2,
      title: 'HUB3 (PDF417)',
      subtitle: 'Skeniraj u hrvatskoj mobilnoj bankarskoj aplikaciji',
      accent: _hub3Color,
      icon: Icons.view_week,
      barcode: Center(child: _pdf417Preview(_hub3Data, _hub3CaptureKey)),
      rawData: _hub3Data,
      baseFilename: 'hub3-pdf417',
      captureKey: _hub3CaptureKey,
      svgBuilder: () => _pdf417Svg(_hub3Data),
    );

    final walletCard = _previewCard(
      index: 3,
      title: 'Wallet QR (EIP-681)',
      subtitle: 'Skeniraj u MetaMask / Rainbow / Coinbase Wallet',
      accent: _walletColor,
      icon: Icons.account_balance_wallet,
      barcode: Center(child: _qrPreview(_walletData, _walletCaptureKey)),
      rawData: _walletData,
      baseFilename: 'wallet-qr',
      captureKey: _walletCaptureKey,
      svgBuilder: () => _qrSvg(_walletData),
    );

    final wide = constraints.maxWidth >= 700;
    return wide
        ? Flex(
            direction: Axis.horizontal,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: epcCard),
              const SizedBox(width: 16),
              Expanded(child: hub3Card),
              const SizedBox(width: 16),
              Expanded(child: walletCard),
            ],
          )
        : Flex(
            direction: Axis.vertical,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              epcCard,
              const SizedBox(height: 24),
              hub3Card,
              const SizedBox(height: 24),
              walletCard,
            ],
          );
  }

  Widget _previewCard({
    required int index,
    required String title,
    required String subtitle,
    required Color accent,
    required IconData icon,
    required Widget barcode,
    required String rawData,
    required String baseFilename,
    required GlobalKey captureKey,
    required String Function() svgBuilder,
  }) {
    return Card(
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: accent.withValues(alpha: 0.25), width: 1),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(height: 4, color: accent),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Container(
                      width: 32,
                      height: 32,
                      decoration: BoxDecoration(
                        color: accent.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      alignment: Alignment.center,
                      child: Text(
                        '$index',
                        style: TextStyle(
                            color: accent,
                            fontWeight: FontWeight.w700,
                            fontSize: 16),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Icon(icon, color: accent, size: 22),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        title,
                        style: TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w700,
                          color: accent,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(subtitle, style: TextStyle(color: Colors.grey[700])),
                const SizedBox(height: 16),
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.grey[200]!),
                  ),
                  child: barcode,
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => _handleDownload(
                          action: () =>
                              _saveSvg(baseFilename, svgBuilder()),
                          successMessage: '$baseFilename.svg spremljen',
                        ),
                        icon: const Icon(Icons.download, size: 18),
                        label: const Text('SVG'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: accent,
                          side: BorderSide(
                              color: accent.withValues(alpha: 0.5)),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: () => _handleDownload(
                          action: () async {
                            final png = await _capturePng(captureKey);
                            await _savePng(baseFilename, png);
                          },
                          successMessage: '$baseFilename.png spremljen',
                        ),
                        icon: const Icon(Icons.image, size: 18),
                        label: const Text('PNG (HD)'),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: accent,
                          side: BorderSide(
                              color: accent.withValues(alpha: 0.5)),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: accent.withValues(alpha: 0.05),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                        color: accent.withValues(alpha: 0.15)),
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
        ],
      ),
    );
  }
}
