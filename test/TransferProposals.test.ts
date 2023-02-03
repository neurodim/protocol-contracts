import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ContractTransaction } from "ethers";
import { deployments, ethers, network } from "hardhat";
import {
    ERC20Mock,
    Pool,
    Service,
    TGE,
    Token,
    Registry,
} from "../typechain-types";
import Exceptions from "./shared/exceptions";
import { CreateArgs, makeCreateData } from "./shared/settings";
import { mineBlock } from "./shared/utils";
import { setup } from "./shared/setup";

const { getContractAt, getContract, getSigners, provider } = ethers;
const { parseUnits } = ethers.utils;
const { AddressZero } = ethers.constants;

describe("Test transfer proposals", function () {
    let owner: SignerWithAddress,
        other: SignerWithAddress,
        third: SignerWithAddress,
        fourth: SignerWithAddress;
    let service: Service, Registry: Registry;
    let pool: Pool, tge: TGE, token: Token;
    let token1: ERC20Mock;
    let snapshotId: any;
    let createArgs: CreateArgs;
    let tx: ContractTransaction;

    before(async function () {
        // Get accounts
        [owner, other, third, fourth] = await getSigners();

        // Fixture
        await deployments.fixture();

        // Get contracts
        service = await getContract("Service");
        Registry = await getContract("Registry");
        token1 = await getContract("ONE");

        // Setup
        await setup();

        // Create TGE
        createArgs = await makeCreateData();
        createArgs[3].userWhitelist = [
            owner.address,
            other.address,
            third.address,
        ];
        await service.createPool(...createArgs, {
            value: parseUnits("0.01"),
        });
        const record = await Registry.contractRecords(0);
        pool = await getContractAt("Pool", record.addr);
        token = await getContractAt("Token", await pool.tokens(1));
        tge = await getContractAt("TGE", await token.tgeList(0));

        // Finalize TGE
        await tge.purchase(parseUnits("1000"), { value: parseUnits("10") });
        await tge
            .connect(other)
            .purchase(parseUnits("1000"), { value: parseUnits("10") });
        await tge
            .connect(third)
            .purchase(parseUnits("1000"), { value: parseUnits("10") });
        await mineBlock(20);
    });

    beforeEach(async function () {
        snapshotId = await network.provider.request({
            method: "evm_snapshot",
            params: [],
        });
    });

    afterEach(async function () {
        snapshotId = await network.provider.request({
            method: "evm_revert",
            params: [snapshotId],
        });
    });

    describe("Transfer ETH", function () {
        this.beforeEach(async function () {
            tx = await pool
                .connect(other)
                .proposeTransfer(
                    AddressZero,
                    [third.address, fourth.address],
                    [parseUnits("0.1"), parseUnits("0.1")],
                    "Let's give them money",
                    "#"
                );
        });

        it("Transfer proposals can only be executed by executor role holder", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);

            await expect(
                pool.connect(other).executeProposal(1)
            ).to.be.revertedWith(Exceptions.INVALID_USER);
        });

        it("Can't execute transfer proposal if pool doesn't hold enough funds", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);

            await expect(pool.executeProposal(1)).to.be.revertedWith(
                "Address: insufficient balance"
            );
        });

        it("Executing succeeded transfer proposals should work", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);
            await owner.sendTransaction({
                to: pool.address,
                value: parseUnits("10"),
            });

            const thirdBefore = await provider.getBalance(third.address);
            const fourthBefore = await provider.getBalance(fourth.address);
            await pool.executeProposal(1);
            const thirdAfter = await provider.getBalance(third.address);
            const fourthAfter = await provider.getBalance(fourth.address);
            expect(await provider.getBalance(pool.address)).to.equal(
                parseUnits("9.8")
            );
            expect(thirdAfter.sub(thirdBefore)).to.equal(parseUnits("0.1"));
            expect(fourthAfter.sub(fourthBefore)).to.equal(parseUnits("0.1"));
        });
    });

    describe("Transfer ERC20", function () {
        this.beforeEach(async function () {
            tx = await pool
                .connect(other)
                .proposeTransfer(
                    token1.address,
                    [third.address],
                    [parseUnits("10")],
                    "Let's give them money in token",
                    "#"
                );
        });

        it("Can't execute transfer proposal if pool doesn't hold enough funds", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);

            await expect(pool.executeProposal(1)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance"
            );
        });

        it("Executing succeeded transfer proposals should work", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);
            await token1.transfer(pool.address, parseUnits("100"));

            await pool.executeProposal(1);
            expect(await token1.balanceOf(pool.address)).to.equal(
                parseUnits("90")
            );
            expect(await token1.balanceOf(third.address)).to.equal(
                parseUnits("10")
            );
        });
    });
});