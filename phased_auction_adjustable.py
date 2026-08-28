import smartpy as sp


@sp.module
def main():
    SCHEDULED = 0
    TIMED = 1
    RESERVE = 2

    GATE_TOKEN_TYPE: type = sp.record(
        fa2=sp.address,
        token_id=sp.nat,
    )

    AUCTION_TYPE: type = sp.record(
        auction_id=sp.nat,
        seller=sp.address,
        nft_contract=sp.address,
        token_id=sp.nat,
        token_amount=sp.nat,
        gate_tokens=sp.list[GATE_TOKEN_TYPE],
        reserve_price=sp.mutez,
        public_reserve_price=sp.mutez,
        gate_duration=sp.int,
        gate_start=sp.timestamp,
        buy_now_price=sp.option[sp.mutez],
        min_bid_increment=sp.nat,
        mode=sp.nat,
        duration=sp.int,
        scheduled_start=sp.option[sp.timestamp],
        started=sp.bool,
        start_time=sp.option[sp.timestamp],
        end_time=sp.option[sp.timestamp],
        settled=sp.bool,
        cancelled=sp.bool,
        highest_bidder=sp.option[sp.address],
        highest_bid=sp.mutez,
        snipe_window=sp.int,
        snipe_extension=sp.int,
    )

    CREATE_AUCTION_TYPE: type = sp.record(
        nft_contract=sp.address,
        token_id=sp.nat,
        token_amount=sp.nat,
        gate_tokens=sp.list[GATE_TOKEN_TYPE],
        reserve_price=sp.mutez,
        public_reserve_price=sp.mutez,
        gate_duration=sp.int,
        buy_now_price=sp.option[sp.mutez],
        min_bid_increment=sp.nat,
        mode=sp.nat,
        duration=sp.int,
        scheduled_start=sp.option[sp.timestamp],
        snipe_window=sp.int,
        snipe_extension=sp.int,
    )

    UPDATE_AUCTION_PRICES_TYPE: type = sp.record(
        auction_id=sp.nat,
        reserve_price=sp.mutez,
        public_reserve_price=sp.mutez,
        buy_now_price=sp.option[sp.mutez],
    )

    FA2_TX_TYPE: type = sp.record(
        to_=sp.address,
        token_id=sp.nat,
        amount=sp.nat,
    ).layout(("to_", ("token_id", "amount")))

    FA2_TRANSFER_ITEM_TYPE: type = sp.record(
        from_=sp.address,
        txs=sp.list[FA2_TX_TYPE],
    ).layout(("from_", "txs"))

    FA2_TRANSFER_TYPE: type = sp.list[FA2_TRANSFER_ITEM_TYPE]

    class GatedAuction(sp.Contract):
        def __init__(self, admin, fee_recipient, fee_percent):
            sp.cast(admin, sp.address)
            sp.cast(fee_recipient, sp.address)
            sp.cast(fee_percent, sp.nat)

            self.data.admin = admin
            self.data.fee_recipient = fee_recipient
            self.data.fee_percent = fee_percent
            self.data.paused = False
            self.data.auctions = sp.cast(
                sp.big_map({}),
                sp.big_map[sp.nat, AUCTION_TYPE],
            )
            self.data.auction_count = 0

        @sp.private(with_storage="read-only")
        def _only_admin(self):
            assert sp.sender == self.data.admin, "NOT_ADMIN"

        @sp.private(with_storage="read-only")
        def _not_paused(self):
            assert not self.data.paused, "CONTRACT_PAUSED"

        @sp.private(with_operations=True)
        def _verify_gate(self, gate_tokens):
            sp.cast(gate_tokens, sp.list[GATE_TOKEN_TYPE])
            is_holder = False
            for gate in gate_tokens:
                bal = sp.view(
                    "get_balance",
                    gate.fa2,
                    sp.record(owner=sp.sender, token_id=gate.token_id),
                    sp.nat,
                ).unwrap_some(error="FA2_VIEW_FAILED")
                if bal > 0:
                    is_holder = True
            assert is_holder, "NOT_GATE_HOLDER"

        @sp.private(with_operations=True)
        def _push(self, params):
            sp.cast(
                params,
                sp.record(
                    to_=sp.address,
                    amount=sp.mutez,
                ),
            )
            if params.amount > sp.mutez(0):
                sp.send(params.to_, params.amount)

        @sp.private(with_operations=True)
        def _make_fa2_transfer(self, params):
            sp.cast(
                params,
                sp.record(
                    nft_contract=sp.address,
                    from_=sp.address,
                    to_=sp.address,
                    token_id=sp.nat,
                    amount=sp.nat,
                ),
            )
            batch = [
                sp.record(
                    from_=params.from_,
                    txs=[
                        sp.record(
                            to_=params.to_,
                            token_id=params.token_id,
                            amount=params.amount,
                        )
                    ],
                )
            ]
            sp.cast(batch, FA2_TRANSFER_TYPE)
            fa2 = sp.contract(
                FA2_TRANSFER_TYPE,
                params.nft_contract,
                entrypoint="transfer",
            ).unwrap_some(error="BAD_FA2_CONTRACT")
            sp.transfer(batch, sp.mutez(0), fa2)

        @sp.private(with_storage="read-only", with_operations=True)
        def _send_settlement(self, auction):
            fee_amount = sp.split_tokens(
                auction.highest_bid,
                self.data.fee_percent,
                10000,
            )
            seller_proceeds = auction.highest_bid - fee_amount
            sp.send(self.data.fee_recipient, fee_amount)
            sp.send(auction.seller, seller_proceeds)

        @sp.entrypoint
        def set_admin(self, new_admin):
            sp.cast(new_admin, sp.address)
            self._only_admin()
            self.data.admin = new_admin

        @sp.entrypoint
        def set_fee(self, params):
            sp.cast(
                params,
                sp.record(
                    fee_recipient=sp.address,
                    fee_percent=sp.nat,
                ),
            )
            self._only_admin()
            assert params.fee_percent <= 1000, "FEE_TOO_HIGH"
            self.data.fee_recipient = params.fee_recipient
            self.data.fee_percent = params.fee_percent

        @sp.entrypoint
        def set_paused(self, paused):
            sp.cast(paused, sp.bool)
            self._only_admin()
            self.data.paused = paused

        @sp.entrypoint
        def create_auction(self, params):
            sp.cast(params, CREATE_AUCTION_TYPE)
            self._not_paused()

            assert (
                (params.mode == SCHEDULED)
                or (params.mode == TIMED)
                or (params.mode == RESERVE)
            ), "INVALID_MODE"
            assert params.duration > 0, "INVALID_DURATION"
            assert params.reserve_price > sp.mutez(0), "INVALID_RESERVE"
            assert (
                params.public_reserve_price >= params.reserve_price
            ), "PUBLIC_RESERVE_BELOW_HOLDER_RESERVE"
            assert params.gate_duration >= 0, "INVALID_GATE_DURATION"
            assert params.token_amount > 0, "INVALID_AMOUNT"
            assert sp.len(params.gate_tokens) > 0, "EMPTY_GATE"
            assert params.min_bid_increment >= 1, "INVALID_INCREMENT"
            assert params.min_bid_increment <= 10000, "INCREMENT_TOO_HIGH"
            assert params.snipe_window >= 0, "INVALID_SNIPE_WINDOW"
            assert params.snipe_extension >= 0, "INVALID_SNIPE_EXTENSION"

            if params.mode == SCHEDULED:
                assert params.scheduled_start.is_some(), "NEED_SCHEDULED_START"
                assert params.scheduled_start.unwrap_some() > sp.now, "START_IN_PAST"

            if params.buy_now_price.is_some():
                assert (
                    params.buy_now_price.unwrap_some() >= params.public_reserve_price
                ), "BUY_NOW_BELOW_RESERVE"

            auction_id = self.data.auction_count

            self._make_fa2_transfer(sp.record(
                nft_contract=params.nft_contract,
                from_=sp.sender,
                to_=sp.self_address(),
                token_id=params.token_id,
                amount=params.token_amount,
            ))

            started = False
            start_time = sp.cast(None, sp.option[sp.timestamp])
            end_time = sp.cast(None, sp.option[sp.timestamp])
            if params.mode == TIMED:
                started = True
                start_time = sp.Some(sp.now)
                end_time = sp.Some(sp.add_seconds(sp.now, params.duration))

            gate_start = sp.now
            if params.mode == SCHEDULED:
                gate_start = params.scheduled_start.unwrap_some()

            self.data.auctions[auction_id] = sp.record(
                auction_id=auction_id,
                seller=sp.sender,
                nft_contract=params.nft_contract,
                token_id=params.token_id,
                token_amount=params.token_amount,
                gate_tokens=params.gate_tokens,
                reserve_price=params.reserve_price,
                public_reserve_price=params.public_reserve_price,
                gate_duration=params.gate_duration,
                gate_start=gate_start,
                buy_now_price=params.buy_now_price,
                min_bid_increment=params.min_bid_increment,
                mode=params.mode,
                duration=params.duration,
                scheduled_start=params.scheduled_start,
                started=started,
                start_time=start_time,
                end_time=end_time,
                settled=False,
                cancelled=False,
                highest_bidder=sp.cast(None, sp.option[sp.address]),
                highest_bid=sp.mutez(0),
                snipe_window=params.snipe_window,
                snipe_extension=params.snipe_extension,
            )
            self.data.auction_count += 1

        @sp.entrypoint
        def start_scheduled_auction(self, auction_id):
            sp.cast(auction_id, sp.nat)
            self._not_paused()
            assert self.data.auctions.contains(auction_id), "NO_AUCTION"
            auction = self.data.auctions[auction_id]
            assert auction.mode == SCHEDULED, "NOT_SCHEDULED"
            assert not auction.started, "ALREADY_STARTED"
            assert not auction.cancelled, "CANCELLED"
            assert sp.now >= auction.scheduled_start.unwrap_some(), "TOO_EARLY"

            self.data.auctions[auction_id].started = True
            self.data.auctions[auction_id].start_time = sp.Some(sp.now)
            self.data.auctions[auction_id].end_time = sp.Some(
                sp.add_seconds(sp.now, auction.duration)
            )

        @sp.entrypoint
        def bid(self, auction_id):
            sp.cast(auction_id, sp.nat)
            self._not_paused()
            assert self.data.auctions.contains(auction_id), "NO_AUCTION"
            auction = self.data.auctions[auction_id]

            assert not auction.settled, "ALREADY_SETTLED"
            assert not auction.cancelled, "CANCELLED"
            assert sp.sender != auction.seller, "SELLER_CANNOT_BID"

            holder_only = sp.now < sp.add_seconds(
                auction.gate_start,
                auction.gate_duration,
            )
            if holder_only:
                self._verify_gate(auction.gate_tokens)

            active_reserve = auction.public_reserve_price
            if holder_only:
                active_reserve = auction.reserve_price

            if auction.mode == SCHEDULED:
                assert auction.started, "NOT_STARTED_YET"

            if auction.mode == RESERVE:
                if not auction.started:
                    assert sp.amount >= active_reserve, "BID_BELOW_RESERVE"
                    self.data.auctions[auction_id].started = True
                    self.data.auctions[auction_id].start_time = sp.Some(sp.now)
                    self.data.auctions[auction_id].end_time = sp.Some(
                        sp.add_seconds(sp.now, auction.duration)
                    )

            auction = self.data.auctions[auction_id]
            if auction.started:
                assert sp.now < auction.end_time.unwrap_some(), "AUCTION_ENDED"

            min_next = active_reserve
            if auction.highest_bid > sp.mutez(0):
                increment = sp.split_tokens(
                    auction.highest_bid,
                    auction.min_bid_increment,
                    10000,
                )
                incremented_bid = auction.highest_bid + increment
                if incremented_bid > min_next:
                    min_next = incremented_bid
            assert sp.amount >= min_next, "BID_TOO_LOW"

            if auction.highest_bidder.is_some():
                self._push(sp.record(
                    to_=auction.highest_bidder.unwrap_some(),
                    amount=auction.highest_bid,
                ))

            self.data.auctions[auction_id].highest_bidder = sp.Some(sp.sender)
            self.data.auctions[auction_id].highest_bid = sp.amount
            auction = self.data.auctions[auction_id]

            if auction.started:
                end_time = auction.end_time.unwrap_some()
                time_left = end_time - sp.now
                if time_left < auction.snipe_window:
                    self.data.auctions[auction_id].end_time = sp.Some(
                        sp.add_seconds(end_time, auction.snipe_extension)
                    )

            if auction.buy_now_price.is_some():
                if sp.amount >= auction.buy_now_price.unwrap_some():
                    self.data.auctions[auction_id].settled = True
                    auction = self.data.auctions[auction_id]
                    self._send_settlement(auction)
                    self._make_fa2_transfer(sp.record(
                        nft_contract=auction.nft_contract,
                        from_=sp.self_address(),
                        to_=sp.sender,
                        token_id=auction.token_id,
                        amount=auction.token_amount,
                    ))

        @sp.entrypoint
        def settle(self, auction_id):
            sp.cast(auction_id, sp.nat)
            assert self.data.auctions.contains(auction_id), "NO_AUCTION"
            auction = self.data.auctions[auction_id]

            assert not auction.settled, "ALREADY_SETTLED"
            assert not auction.cancelled, "CANCELLED"
            assert auction.started, "NOT_STARTED"
            assert sp.now >= auction.end_time.unwrap_some(), "AUCTION_NOT_ENDED"

            self.data.auctions[auction_id].settled = True
            auction = self.data.auctions[auction_id]

            if auction.highest_bidder.is_some():
                winner = auction.highest_bidder.unwrap_some()
                self._send_settlement(auction)
                self._make_fa2_transfer(sp.record(
                    nft_contract=auction.nft_contract,
                    from_=sp.self_address(),
                    to_=winner,
                    token_id=auction.token_id,
                    amount=auction.token_amount,
                ))
            else:
                self._make_fa2_transfer(sp.record(
                    nft_contract=auction.nft_contract,
                    from_=sp.self_address(),
                    to_=auction.seller,
                    token_id=auction.token_id,
                    amount=auction.token_amount,
                ))

        @sp.entrypoint
        def update_auction_prices(self, params):
            sp.cast(params, UPDATE_AUCTION_PRICES_TYPE)
            self._not_paused()
            assert self.data.auctions.contains(params.auction_id), "NO_AUCTION"
            auction = self.data.auctions[params.auction_id]

            assert sp.sender == auction.seller, "NOT_SELLER"
            assert not auction.settled, "ALREADY_SETTLED"
            assert not auction.cancelled, "ALREADY_CANCELLED"
            assert not auction.highest_bidder.is_some(), "BIDS_EXIST"
            assert auction.highest_bid == sp.mutez(0), "BIDS_EXIST"
            assert params.reserve_price > sp.mutez(0), "INVALID_RESERVE"
            assert (
                params.public_reserve_price >= params.reserve_price
            ), "PUBLIC_RESERVE_BELOW_HOLDER_RESERVE"
            if params.buy_now_price.is_some():
                assert (
                    params.buy_now_price.unwrap_some() > params.public_reserve_price
                ), "BUY_NOW_NOT_ABOVE_PUBLIC_RESERVE"

            self.data.auctions[params.auction_id].reserve_price = params.reserve_price
            self.data.auctions[params.auction_id].public_reserve_price = params.public_reserve_price
            self.data.auctions[params.auction_id].buy_now_price = params.buy_now_price

        @sp.entrypoint
        def cancel_auction(self, auction_id):
            sp.cast(auction_id, sp.nat)
            assert self.data.auctions.contains(auction_id), "NO_AUCTION"
            auction = self.data.auctions[auction_id]

            assert not auction.settled, "ALREADY_SETTLED"
            assert not auction.cancelled, "ALREADY_CANCELLED"

            is_admin = sp.sender == self.data.admin
            is_seller = sp.sender == auction.seller
            assert is_admin or is_seller, "NOT_AUTHORIZED"

            if is_seller and not is_admin:
                assert not auction.highest_bidder.is_some(), "BIDS_EXIST"

            self.data.auctions[auction_id].cancelled = True

            if auction.highest_bidder.is_some():
                self._push(sp.record(
                    to_=auction.highest_bidder.unwrap_some(),
                    amount=auction.highest_bid,
                ))
                self.data.auctions[auction_id].highest_bidder = sp.cast(
                    None,
                    sp.option[sp.address],
                )
                self.data.auctions[auction_id].highest_bid = sp.mutez(0)

            self._make_fa2_transfer(sp.record(
                nft_contract=auction.nft_contract,
                from_=sp.self_address(),
                to_=auction.seller,
                token_id=auction.token_id,
                amount=auction.token_amount,
            ))

        @sp.onchain_view
        def get_auction(self, auction_id):
            sp.cast(auction_id, sp.nat)
            assert self.data.auctions.contains(auction_id), "NO_AUCTION"
            return self.data.auctions[auction_id]

        @sp.onchain_view
        def get_auction_count(self):
            return self.data.auction_count

        @sp.onchain_view
        def auction_is_live(self, auction_id):
            sp.cast(auction_id, sp.nat)
            assert self.data.auctions.contains(auction_id), "NO_AUCTION"
            auction = self.data.auctions[auction_id]
            live = False
            if auction.started and not auction.settled and not auction.cancelled:
                if sp.now < auction.end_time.unwrap_some():
                    live = True
            return live

        @sp.onchain_view
        def auction_holder_only(self, auction_id):
            sp.cast(auction_id, sp.nat)
            assert self.data.auctions.contains(auction_id), "NO_AUCTION"
            auction = self.data.auctions[auction_id]
            return sp.now < sp.add_seconds(
                auction.gate_start,
                auction.gate_duration,
            )

        @sp.onchain_view
        def is_gated_holder(self, params):
            sp.cast(
                params,
                sp.record(
                    holder=sp.address,
                    gate_tokens=sp.list[GATE_TOKEN_TYPE],
                ),
            )
            result = False
            for gate in params.gate_tokens:
                bal = sp.view(
                    "get_balance",
                    gate.fa2,
                    sp.record(owner=params.holder, token_id=gate.token_id),
                    sp.nat,
                ).unwrap_some(error="FA2_VIEW_FAILED")
                if bal > 0:
                    result = True
            return result


@sp.add_test()
def test():
    scenario = sp.test_scenario("GatedAuction compile smoke", main)

    admin = sp.test_account("Admin")
    fee_wallet = sp.test_account("FeeWallet")

    contract = main.GatedAuction(
        admin=admin.address,
        fee_recipient=fee_wallet.address,
        fee_percent=sp.nat(250),
    )
    scenario += contract
    scenario.verify(contract.data.auction_count == 0)
