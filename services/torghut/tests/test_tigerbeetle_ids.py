from __future__ import annotations

import uuid
from unittest import TestCase

from app.trading.tigerbeetle_ids import stable_u128, u128_decimal, uuid_to_u128


class TestTigerBeetleIds(TestCase):
    def test_uuid_conversion_is_stable(self) -> None:
        value = uuid.UUID("018f0f4b-6e44-7c6e-9e3d-7d272ee6b2a1")

        self.assertEqual(uuid_to_u128(value), value.int)

    def test_uuid_zero_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "tigerbeetle_id_zero"):
            uuid_to_u128(uuid.UUID(int=0))

    def test_hash_ids_are_stable_and_nonzero(self) -> None:
        first = stable_u128("torghut.execution", "order-1")
        second = stable_u128("torghut.execution", "order-1")

        self.assertEqual(first, second)
        self.assertGreater(first, 0)

    def test_hash_ids_include_namespace(self) -> None:
        self.assertNotEqual(
            stable_u128("torghut.execution", "shared"),
            stable_u128("torghut.transfer", "shared"),
        )

    def test_decimal_serialization_rejects_out_of_range_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "tigerbeetle_id_out_of_range"):
            u128_decimal(0)
