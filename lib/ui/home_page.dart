import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:barcode/barcode.dart' as bc;
import 'package:barcode_widget/barcode_widget.dart';
import 'package:file_saver/file_saver.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../main.dart' show DomovinaBrand;
import '../models/eip681_payload.dart';
import '../models/epc_payload.dart';
import '../models/hub3_payload.dart';
import '../utils/eip55.dart';
import 'gnosis_history_page.dart';
import 'hpb_history_page.dart';
import 'payment_status_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  static const _epcColor = DomovinaBrand.navy;     // SEPA — primary brand
  static const _hub3Color = DomovinaBrand.red;     // Hrvatska — Croatian red
  static const _walletColor = DomovinaBrand.muted; // Web3 — secondary slate

  /// User must explicitly tick a confirmation checkbox before the QR
  /// preview cards reveal. Resets automatically on every change to the
  /// target address — protects against typo-then-scan, since funds sent
  /// on-chain to a wrong address are irreversible. See
  /// backend/safe-tx/RISK-MITIGATIONS.md for the full catalogue of typo
  /// defenses we considered.
  bool _addressConfirmed = false;

  final _name = TextEditingController(text: 'ITalk d.o.o.');
  final _address = TextEditingController(text: 'IX. Južna obala 20');
  final _city = TextEditingController(text: 'Zagreb');
  final _amount = TextEditingController(text: '1.01');

  // Default = MPT main-rail Safe. With MPT routing model, the EPC remittance
  // carries `mpt:<address>?sid=<id>`; Monerium mints to the Safe regardless,
  // then the backend forwards EURe to <address> via Zodiac Roles Modifier.
  // Defaulting the address to the Safe itself means "park EURe in Safe and
  // stop" — backend short-circuits with self_target_noop. User overrides
  // this field per QR for actual onward routing. Old direct-recipient default
  // 0x6693a7D19486Dc45e9F90Fd2D515d972bBA2d65e is no longer Monerium's
  // canonical destination after 2026-05-21 Safe default-wallet switch.
  final _gnosisAddress = TextEditingController(
      text: '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e');

  /// Session id appended to the SEPA remittance as `?sid=<value>`. Backend
  /// (monerium.domovina.ai) extracts it from the Monerium webhook payload to
  /// match the incoming EURe mint against the browser session that generated
  /// the QR. Default is a fresh random id; user can edit or "Random" again.
  final _sid = TextEditingController(text: _randomSid());

  static String _randomSid() {
    // Confusable-free alphabet (no 0/O/1/l), 32 chars × 12 positions =
    // 32^12 ≈ 1.15e18 (~60 bits). Birthday-collision at 50% sits near
    // 10^9 payments — comfortable for onchain join-key duty in the
    // PaymentRegistry feed. Still fits bytes32 onchain and stays under
    // SEPA memo limits when wrapped as `mpt:0x…?sid=<id>`.
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    final r = Random.secure();
    return List.generate(12, (_) => chars[r.nextInt(chars.length)]).join();
  }

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
        _name, _address, _city, _amount, _gnosisAddress, _sid,
        _hrIban, _model, _reference,
        _eeIban, _bic, _epcPurpose,
        _walletChainId, _walletTokenContract, _walletTokenDecimals,
      ];

  String get _gnosisAddr => _gnosisAddress.text.trim();
  Eip55Result get _addressValidation => Eip55.validate(_gnosisAddr);
  bool get _isValidGnosisAddress =>
      _addressValidation == Eip55Result.validChecksum ||
      _addressValidation == Eip55Result.validNoChecksum;
  String get _sidValue => _sid.text.trim();

  /// EPC remittance now uses MPT routing scheme: Monerium default wallet is
  /// the MPT main-rail Safe, so ALL incoming SEPA mints to one place
  /// regardless of memo. The 140-char remittance is therefore ours to use
  /// for off-Monerium routing: `mpt:0x<target>?sid=<id>` is parsed by the
  /// monerium.domovina.ai webhook handler, which then submits an
  /// `execTransactionWithRole` TX via the Safe's Zodiac Roles Modifier to
  /// forward EURe to the actual recipient. See [[reference-mpt-brand]].
  String get _epcRemittance => _sidValue.isEmpty
      ? 'mpt:$_gnosisAddr'
      : 'mpt:$_gnosisAddr?sid=$_sidValue';

  /// HUB3 PDF417 → Croatian HR IBAN → does NOT go through Monerium, so the
  /// description field is free for sid tracking + anything else.
  String get _hub3Description => _sidValue.isEmpty
      ? 'gnosis:$_gnosisAddr'
      : 'gnosis:$_gnosisAddr?sid=$_sidValue';

  @override
  void initState() {
    super.initState();
    for (final c in _allControllers) {
      c.addListener(() => setState(() {}));
    }
    // Any change to the target address voids prior confirmation. This is
    // the typo-protection invariant: confirmation always reflects the
    // exact bytes the user last verified, never a previous version.
    _gnosisAddress.addListener(() {
      if (_addressConfirmed) {
        setState(() => _addressConfirmed = false);
      }
    });
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
        remittanceInfo: _epcRemittance,
      ).build();

  String get _hub3Data => Hub3Payload(
        amount: _amountValue,
        name: _name.text.trim(),
        address: _address.text.trim(),
        city: _city.text.trim(),
        iban: _hrIban.text.trim(),
        model: _model.text.trim(),
        reference: _reference.text.trim(),
        description: _hub3Description,
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
          title: RichText(
            text: const TextSpan(
              style: TextStyle(
                color: DomovinaBrand.white,
                fontSize: 18,
                fontWeight: FontWeight.w800,
                letterSpacing: 2,
              ),
              children: [
                TextSpan(text: 'pay.'),
                TextSpan(text: 'DOMOVINA'),
                TextSpan(
                  text: '.ai',
                  style: TextStyle(color: DomovinaBrand.red),
                ),
              ],
            ),
          ),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(52),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const TabBar(
                  tabs: [
                    Tab(
                        icon: Icon(Icons.qr_code_2),
                        text: 'Generator barkoda'),
                    Tab(
                        icon: Icon(Icons.account_balance_wallet),
                        text: 'Gnosis EURe'),
                    Tab(
                        icon: Icon(Icons.account_balance),
                        text: 'HPB IBAN'),
                  ],
                ),
                Row(
                  children: const [
                    Expanded(
                        child: ColoredBox(
                            color: DomovinaBrand.red,
                            child: SizedBox(height: 3))),
                    Expanded(
                        child: ColoredBox(
                            color: DomovinaBrand.white,
                            child: SizedBox(height: 3))),
                    Expanded(
                        child: ColoredBox(
                            color: DomovinaBrand.navy,
                            child: SizedBox(height: 3))),
                  ],
                ),
              ],
            ),
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
          helper: _addressHelperText(),
          errorText: _addressErrorText(),
        ),
        _buildConfirmTargetBanner(),
        // Session id field. Ide u EPC remittance kao `mpt:0x...?sid=<id>` —
        // Monerium ignorira sve (mint-a na MPT Safe), backend čita memo i
        // forwarda EURe na pravi wallet kroz Zodiac Roles Modifier. SID
        // omogućuje real-time match browser sessiona s primljenom uplatom.
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextField(
                  controller: _sid,
                  decoration: InputDecoration(
                    labelText: 'Session ID (MPT routing marker)',
                    helperText: _sidValue.isEmpty
                        ? 'Prazno = EPC remittance je čisti mpt:$_gnosisAddr (bez tracking-a)'
                        : 'EPC remittance: $_epcRemittance',
                    helperMaxLines: 2,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: OutlinedButton.icon(
                  onPressed: () => setState(() {
                    _sid.text = _randomSid();
                  }),
                  icon: const Icon(Icons.casino_outlined, size: 18),
                  label: const Text('Random'),
                ),
              ),
            ],
          ),
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

  String _addressHelperText() {
    switch (_addressValidation) {
      case Eip55Result.validChecksum:
        return '✓ EIP-55 checksum potvrđen — adresa je vjerojatno bez tipfelera';
      case Eip55Result.validNoChecksum:
        return 'Validan format (sve mala/velika slova — bez EIP-55 typo zaštite). '
            'Za jaču provjeru, kopiraj adresu s mixed-case iz wallet-a.';
      case Eip55Result.badChecksum:
        return 'EIP-55 checksum NE stima — gotovo sigurno typo. '
            'Predloženo: ${Eip55.toChecksumAddress(_gnosisAddr)}';
      case Eip55Result.invalidFormat:
        return 'Mora biti validna 0x adresa (40 hex znakova)';
    }
  }

  String? _addressErrorText() {
    switch (_addressValidation) {
      case Eip55Result.invalidFormat:
        return 'Nevažeća adresa';
      case Eip55Result.badChecksum:
        return 'Neispravan EIP-55 checksum';
      case Eip55Result.validChecksum:
      case Eip55Result.validNoChecksum:
        return null;
    }
  }

  Widget _buildConfirmTargetBanner() {
    final canConfirm = _isValidGnosisAddress;
    final bgColor = _addressConfirmed
        ? DomovinaBrand.surface
        : const Color(0xFFFFF4E5); // soft amber — "action needed"
    final borderColor = _addressConfirmed
        ? const Color(0xFF2E8540)
        : const Color(0xFFE8B96E);
    return Container(
      margin: const EdgeInsets.only(top: 4, bottom: 12),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: bgColor,
        border: Border.all(color: borderColor),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            _addressConfirmed
                ? Icons.lock_open_rounded
                : Icons.warning_amber_rounded,
            size: 22,
            color: _addressConfirmed ? const Color(0xFF2E8540) : const Color(0xFFB45309),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _addressConfirmed
                      ? 'Target adresa potvrđena — QR kodovi su otključani'
                      : 'EURe poslan na krivu adresu je nepovratan',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: DomovinaBrand.navy,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _addressConfirmed
                      ? 'Bilo kakva promjena adrese resetira potvrdu.'
                      : 'Backend će automatski forwardirati EURe sa Safe-a na adresu '
                        'iznad. Provjeri da je točna prije skeniranja QR-a.',
                  style: const TextStyle(
                    fontSize: 12,
                    height: 1.4,
                    color: DomovinaBrand.muted,
                  ),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    SizedBox(
                      height: 24,
                      width: 24,
                      child: Checkbox(
                        value: _addressConfirmed,
                        onChanged: canConfirm
                            ? (v) => setState(() => _addressConfirmed = v ?? false)
                            : null,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        canConfirm
                            ? 'Potvrđujem da je target adresa točna'
                            : 'Najprije unesi validnu 0x adresu',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: canConfirm
                              ? DomovinaBrand.navy
                              : DomovinaBrand.muted,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _unconfirmedPlaceholder() {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            const Icon(Icons.lock_rounded, size: 48, color: DomovinaBrand.muted),
            const SizedBox(height: 16),
            const Text(
              'QR kodovi su zaključani',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w700,
                color: DomovinaBrand.navy,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              _isValidGnosisAddress
                  ? 'Potvrdi target adresu (checkbox iznad) da otkriješ QR kodove. '
                    'Ovo je sigurnosni step — EURe poslan na krivu adresu je nepovratan.'
                  : 'Najprije unesi validnu Gnosis 0x adresu u polje iznad.',
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 14,
                height: 1.5,
                color: DomovinaBrand.muted,
              ),
            ),
          ],
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
    // Gate: until the user explicitly confirms the routing target, hide
    // every QR card. The MPT backend will auto-forward EURe to whatever
    // address it parses out of the EPC remittance — a typo here is
    // irreversibly painful, so the QR is unscannable until checkbox ticked.
    if (!_addressConfirmed) return _unconfirmedPlaceholder();

    final trackCard = _buildTrackStatusCard();

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
    final cards = wide
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [trackCard, const SizedBox(height: 16), cards],
    );
  }

  /// Entry into the in-app status timeline (and merchant POS mode). Creates
  /// the payment intent on the backend with the SAME sid the QR remittance
  /// carries, then polls the per-stage status. Requires a sid (without it
  /// the backend cannot correlate the incoming Monerium order).
  Widget _buildTrackStatusCard() {
    final canTrack =
        _isValidGnosisAddress && _sidValue.isNotEmpty && _amountValue > 0;
    return Card(
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(
            color: DomovinaBrand.navy.withValues(alpha: 0.25), width: 1),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: const [
                Icon(Icons.timeline, color: DomovinaBrand.navy, size: 22),
                SizedBox(width: 8),
                Text(
                  'Status uplate uživo',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: DomovinaBrand.navy,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              canTrack
                  ? 'Prati uplatu korak po korak — od banke, preko Moneriuma, '
                      'do primatelja. POS mod daje veliki prikaz za pult.'
                  : 'Za praćenje statusa unesi iznos > 0 i Session ID '
                      '(gumb Random).',
              style: TextStyle(color: Colors.grey[700], height: 1.4),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: canTrack ? () => _openStatus(false) : null,
                    icon: const Icon(Icons.travel_explore, size: 18),
                    label: const Text('Prati status'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: canTrack ? () => _openStatus(true) : null,
                    icon: const Icon(Icons.storefront, size: 18),
                    label: const Text('POS mod'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _openStatus(bool posMode) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PaymentStatusPage(
          sid: _sidValue,
          targetAddress: _gnosisAddr,
          amountEur: _amountValue,
          startInPosMode: posMode,
        ),
      ),
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
