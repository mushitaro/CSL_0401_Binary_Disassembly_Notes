"""Regression tests pinning the XDF parse and the binary decode.

The numeric expectations here were established by hand against the flash image
before the parser existed, so they check the parser rather than merely
restating it.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools" / "pipeline"))

import parse_xdf  # noqa: E402
from xdfmath import MathError, apply  # noqa: E402

XDF = REPO / "XDF" / "CSL_0401_Karter16_v3_6_publish.xdf"
BIN = REPO / "Full 211323000401PD31_TERRA.bin"


@pytest.fixture(scope="module")
def parsed():
    categories, items, meta = parse_xdf.parse(XDF)
    blob = BIN.read_bytes()
    links = parse_xdf.build_link_values(items, blob)
    parse_xdf.decode(items, blob, links)
    return categories, {it.name: it for it in items}, meta, blob


def test_item_counts(parsed):
    _cats, by_name, _meta, _blob = parsed
    kinds = {}
    for it in by_name.values():
        kinds[it.kind] = kinds.get(it.kind, 0) + 1
    assert kinds == {"constant": 1782, "curve": 353, "map": 394}
    assert len(by_name) == 2529


def test_category_count_and_bilingual_split(parsed):
    categories, _by_name, _meta, _blob = parsed
    assert len(categories) == 71
    assert categories[0x47]["de"] == "Zuendung"
    assert categories[0x47]["en"] == "Ignition"
    assert categories[0x4D]["en"] == "CSL Snorkel Flap"


def test_categorymem_is_one_greater_than_hex_category_index(parsed):
    """CATEGORYMEM category="11" must resolve to CATEGORY index="0xA"."""
    categories, by_name, _meta, _blob = parsed

    kf_rg_m = by_name["KF_RG_M"]
    assert kf_rg_m.categories == [0x0A, 0x50]
    assert categories[0x0A]["en"] == "CSL Specific"
    assert categories[0x50]["de"] == "Restgas"

    flap = by_name["k_ask_flap_driver_energised_cycles_threshold"]
    assert 0x4D in flap.categories
    assert categories[0x4D]["en"] == "CSL Snorkel Flap"


def test_kf_rg_m_axes_decode_to_physical_units(parsed):
    """Hand-verified: the x axis is a clean rpm ladder, y is rf in 0.1 steps."""
    _cats, by_name, _meta, _blob = parsed
    item = by_name["KF_RG_M"]
    assert item.kind == "map"

    x = item.axes["x"]
    assert x.address == 0xE42C
    assert x.units == "rpm"
    assert x.values == [
        0, 500, 1000, 1500, 2000, 2500, 3000, 3500,
        4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500,
    ]

    y = item.axes["y"]
    assert y.address == 0xE44C
    # raw 0,100,...,1100 scaled by "X/1000"
    assert y.values == [round(v / 1000, 6) for v in range(0, 1200, 100)]

    z = item.axes["z"]
    assert z.address == 0xE464
    assert (z.rows, z.cols) == (12, 16)
    assert len(z.values) == 12 and all(len(row) == 16 for row in z.values)


def test_constant_decodes_with_scaling(parsed):
    _cats, by_name, _meta, _blob = parsed
    item = by_name["K_KVA_NORM"]
    assert item.address == 0xBE8
    assert item.element_bits == 8
    assert item.equation == "x*0.0078125"
    assert item.value == pytest.approx(item.raw * 0.0078125)


def test_signed_flag_is_read_from_typeflags(parsed):
    _cats, by_name, _meta, _blob = parsed
    signed = [it for it in by_name.values() if it.kind == "constant" and it.signed]
    assert signed, "expected some mmedtypeflags=0x01 constants"


def test_label_only_axes_have_no_address(parsed):
    """The 482 DTC enumeration axes carry LABELs instead of embedded data."""
    _cats, by_name, _meta, _blob = parsed
    label_axes = [
        a
        for it in by_name.values()
        for a in it.axes.values()
        if a.address is None
    ]
    assert len(label_axes) == 482
    assert all(a.labels for a in label_axes)
    dtc = by_name["DTC_83_DSC_IMPLAUS"]
    assert dtc.axes["x"].labels[:3] == ["DTC", "SIN", "SOUT"]


def test_confidence_split_matches_naming_convention(parsed):
    _cats, by_name, _meta, _blob = parsed
    derived = [n for n, it in by_name.items() if it.confidence == "derived"]
    assert len(derived) == 158
    assert all(n[:1].islower() for n in derived)


def test_decode_failures_are_few_and_named(parsed):
    """Only genuinely undefined items may fail; regressions must show up here."""
    _cats, by_name, _meta, _blob = parsed
    failed = {n for n, it in by_name.items() if it.decode_error}
    # K_VERS_UP_S carries no mmedaddress at all.  Nothing else may fail: the
    # three division-by-zero failures that used to appear here were slave
    # parameters being read from the master bootloader, and they went away
    # once the 0x88000 slave mapping was applied.
    assert failed == {"K_VERS_UP_S"}


def test_master_slave_split_of_the_xdf_region(parsed):
    """The XDF's 64 KB region is Slave below 0x8000 and Master above it."""
    _cats, by_name, _meta, _blob = parsed

    assert by_name["cfg_m.baureihe"].address == 0x8006
    assert by_name["cfg_s.baureihe"].address == 0x0006
    assert parse_xdf.bank_of(0x8006) == "master"
    assert parse_xdf.bank_of(0x0006) == "slave"

    banks = {}
    for it in by_name.values():
        if it.address is not None:
            banks[parse_xdf.bank_of(it.address)] = (
                banks.get(parse_xdf.bank_of(it.address), 0) + 1
            )
    assert banks == {"slave": 1232, "master": 1296}


def test_slave_addresses_map_into_the_mapped_parameter_space(parsed):
    """File offsets and Ghidra program addresses use different bases.

    In the flash image the slave calibration sits at A+0x88000 while the master
    calibration sits where the XDF says.  Inside either Ghidra program the
    annotated calibration lives in the mapped window at 0x88000-0x8FFFF.
    """
    assert parse_xdf.file_offset(0x0006) == 0x88006
    assert parse_xdf.file_offset(0xE42C) == 0xE42C
    # cfg_s.baureihe: slave program 0x88006; cfg_m.baureihe: master 0x88006.
    assert parse_xdf.program_address(0x0006) == 0x88006
    assert parse_xdf.program_address(0x8006) == 0x88006
    # KF_RG_M's x axis, annotated in the master at 0x8E42C (symbol at 0x8E42A).
    assert parse_xdf.program_address(0xE42C) == 0x8E42C

    _cats, by_name, _meta, blob = parsed
    # The same configuration block is mirrored on both CPUs.
    master = blob[0x8006:0x8013]
    slave = blob[0x88006:0x88013]
    assert master == slave


def test_slave_axes_decode_to_monotonic_ladders(parsed):
    """Wrong-offset decoding produced noise; the right offset produces ramps.

    Of the slave-range x axes with four or more points, all should be
    monotonic once A+0x88000 is applied.  Direction is not fixed: nine axes
    scale through a negative coefficient ("-x/10", "x*(-40)"), so their
    physical values descend while the stored bytes ascend.
    """
    _cats, by_name, _meta, _blob = parsed
    total = monotonic = 0
    offenders = []
    for it in by_name.values():
        ax = it.axes.get("x")
        if not ax or ax.address is None or ax.address >= parse_xdf.SLAVE_LIMIT:
            continue
        if not ax.values or len(ax.values) < 4:
            continue
        total += 1
        pairs = list(zip(ax.values, ax.values[1:]))
        if all(b >= a for a, b in pairs) or all(b <= a for a, b in pairs):
            monotonic += 1
        else:
            offenders.append(it.name)
    assert total >= 200
    assert monotonic == total, f"{offenders} are not monotonic"


def test_description_address_cross_check(parsed):
    """At most a handful of items may quote an address they do not own."""
    _cats, by_name, _meta, _blob = parsed
    bad = {n for n, it in by_name.items() if it.desc_addr_mismatch}
    # These six quote an address two bytes below their first axis.
    assert bad == {
        "KL_MD_NBEGR_P", "kl_tog_level_can", "kl_trg_ti",
        "kl_trg_tz", "KL_TABG_STAND", "kf_trg",
    }


def test_all_addresses_are_inside_the_master_calibration_block(parsed):
    _cats, by_name, _meta, _blob = parsed
    for it in by_name.values():
        for addr in (it.address, it.data_address):
            if addr is not None:
                assert 0 <= addr < parse_xdf.CAL_LIMIT, f"{it.name} at {addr:#x}"


# --------------------------------------------------------------------------- #
# xdfmath
# --------------------------------------------------------------------------- #


def test_caret_is_power_and_binds_tighter_than_divide():
    """TunerPro's "x/2^14" means x/16384, not (x/2)**14."""
    assert apply("x/2^14", 32768.0) == pytest.approx(2.0)


@pytest.mark.parametrize(
    "equation,raw,expected",
    [
        ("X", 42, 42),
        ("x/10", 255, 25.5),
        ("x-48", 100, 52),
        ("x*100/32768", 32768, 100),
        ("x/(10*64)", 640, 1.0),
        ("5.12/x", 2, 2.56),
    ],
)
def test_equation_samples(equation, raw, expected):
    assert apply(equation, float(raw)) == pytest.approx(expected)


def test_linked_variable_binds():
    assert apply("(X/k)*10", 100.0, {"k": 5.0}) == pytest.approx(200.0)


@pytest.mark.parametrize("equation", ["__import__('os')", "x if x else 0", "open('f')"])
def test_unsafe_expressions_are_rejected(equation):
    with pytest.raises(MathError):
        apply(equation, 1.0)


def test_division_by_zero_is_a_math_error_not_a_crash():
    with pytest.raises(MathError):
        apply("5.12/x", 0.0)
