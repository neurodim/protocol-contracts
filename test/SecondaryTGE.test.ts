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
import {
    CreateArgs,
    makeCreateData,
    TGEArgs,
    makeTGEArgs,
} from "./shared/settings";
import { mineBlock } from "./shared/utils";
import { setup } from "./shared/setup";

const { getContractAt, getContract, getSigners, provider } = ethers;
const { parseUnits } = ethers.utils;

describe("Test secondary TGE", function () {
    let owner: SignerWithAddress,
        other: SignerWithAddress,
        third: SignerWithAddress,
        fourth: SignerWithAddress;
    let service: Service, registry: Registry;
    let pool: Pool, tge: TGE, token: Token;
    let token1: ERC20Mock;
    let snapshotId: any;
    let createArgs: CreateArgs;
    let tgeArgs: TGEArgs;
    let tx: ContractTransaction;

    before(async function () {
        // Get accounts
        [owner, other, third, fourth] = await getSigners();

        // Fixture
        await deployments.fixture();

        // Get contracts
        service = await getContract("Service");
        registry = await getContract("Registry");
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
        const record = await registry.contractRecords(0);
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

    describe("Secondary TGE for governance token", async function () {
        this.beforeEach(async function () {
            // Propose secondary TGE
            tgeArgs = await makeTGEArgs(createArgs[3]);
            tx = await pool.proposeTGE(...tgeArgs);
        });

        it("Only user with votes over proposal threshold can create secondary TGE proposals", async function () {
            await expect(
                pool.connect(fourth).proposeTGE(...tgeArgs)
            ).to.be.revertedWith(Exceptions.THRESHOLD_NOT_REACHED);
        });

        it("Proposing secondary TGE works", async function () {
            await expect(tx).to.emit(pool, "ProposalCreated");

            const receipt = await tx.wait();
            const proposal = await pool.proposals(1);
            expect(proposal.core.quorumThreshold).to.equal(
                createArgs[6].quorumThreshold
            ); // from create params
            expect(proposal.core.decisionThreshold).to.equal(
                createArgs[6].decisionThreshold
            ); // from create params
            expect(proposal.vote.startBlock).to.equal(receipt.blockNumber + 1);
            expect(proposal.vote.endBlock).to.equal(
                receipt.blockNumber +
                    1 +
                    Number.parseInt(createArgs[6].votingDuration.toString())
            ); // from create params
            expect(proposal.vote.forVotes).to.equal(0);
            expect(proposal.vote.againstVotes).to.equal(0);
            expect(proposal.vote.executionState).to.equal(0);
        });

        it("Can propose secondary TGE when there is active proposal", async function () {
            await expect(pool.proposeTGE(...tgeArgs)).to.be.not.reverted;
        });

        it("Casting votes should work", async function () {
            await expect(pool.castVote(1, true))
                .to.emit(pool, "VoteCast")
                .withArgs(owner.address, 1, parseUnits("500"), 2);

            const proposal = await pool.proposals(1);
            expect(proposal.vote.forVotes).to.equal(parseUnits("500"));
        });

        it("Can't vote after voting period is finished", async function () {
            await mineBlock(25);

            await expect(
                pool.connect(other).castVote(1, true)
            ).to.be.revertedWith(Exceptions.VOTING_FINISHED);
        });

        it("Can't execute non-existent proposal", async function () {
            await expect(pool.executeProposal(2)).to.be.revertedWith(
                Exceptions.WRONG_STATE
            );
        });

        it("Can't execute proposal if quorum is not reached", async function () {
            await mineBlock(25);

            await expect(pool.executeProposal(1)).to.be.revertedWith(
                Exceptions.WRONG_STATE
            );
        });

        it("Can't execute proposal with uncertain state before voting period is finished", async function () {
            await pool.connect(other).castVote(1, true);
            await pool.connect(owner).castVote(1, false);

            await expect(pool.executeProposal(1)).to.be.revertedWith(
                Exceptions.WRONG_STATE
            );
        });

        it("Can't execute inevitably successful proposal before voting period is finished and BEFORE delay passed", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);

            await expect(pool.executeProposal(1)).to.be.revertedWith(
                Exceptions.WRONG_STATE
            );
        });

        it("Can't execute inevitably successful proposal before voting period is finished and AFTER delay passed", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);

            await mineBlock(2);

            await expect(pool.executeProposal(1)).to.emit(
                service,
                "SecondaryTGECreated"
            );
        });

        it("Can execute successful proposal, creating secondary TGE", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(25);

            await expect(pool.executeProposal(1)).to.emit(
                service,
                "SecondaryTGECreated"
            );

            const tgeRecord = await registry.contractRecords(3);
            const tge2: TGE = await getContractAt("TGE", tgeRecord.addr);

            expect(await tge2.state()).to.equal(0);

            const info = await tge2.info();
            expect(info.duration).to.equal(20);
            expect(info.softcap).to.equal(parseUnits("1000"));
            expect(info.hardcap).to.equal(parseUnits("5000"));
        });

        it("Only pool can request creating TGEs and recording proposals on service", async function () {
            await expect(
                service.createSecondaryTGE(
                    createArgs[3],
                    {
                        tokenType: 1,
                        name: "",
                        symbol: "",
                        cap: 0,
                        decimals: 0,
                        description: "",
                    },
                    ""
                )
            ).to.be.revertedWith(Exceptions.NOT_POOL);

            await expect(service.addProposal(35)).to.be.revertedWith(
                Exceptions.NOT_POOL
            );
        });

        it("Can buy from secondary TGE", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);
            await pool.executeProposal(1);
            const tgeRecord = await registry.contractRecords(3);
            const tge2: TGE = await getContractAt("TGE", tgeRecord.addr);

            await tge2
                .connect(owner)
                .purchase(parseUnits("100"), { value: parseUnits("1") });
        });

        it("If anything is purchased (no softcap) than TGE is successful", async function () {
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);
            await pool.executeProposal(1);
            const tgeRecord = await registry.contractRecords(3);
            const tge2: TGE = await getContractAt("TGE", tgeRecord.addr);

            await tge2
                .connect(owner)
                .purchase(parseUnits("10"), { value: parseUnits("1") });
            await mineBlock(25);
            expect(await tge2.state()).to.equal(2);
        });

        it("New TGE can't be created before previous TGE is finished", async function () {
            // Succeed and execute first proposal
            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);
            await pool.executeProposal(1);

            // Create and success second proposal
            createArgs[3].hardcap = parseUnits("1000");
            await pool.proposeTGE(...tgeArgs);
            await pool.connect(owner).castVote(2, true);
            await pool.connect(other).castVote(2, true);
            await mineBlock(2);

            // Execution should fail
            await expect(pool.executeProposal(2)).to.be.revertedWith(
                Exceptions.ACTIVE_TGE_EXISTS
            );
        });

        it("Secondary TGE's hardcap can't overflow remaining (unminted) supply", async function () {
            await mineBlock(25);

            createArgs[3].hardcap = parseUnits("9500");

            await expect(pool.proposeTGE(...tgeArgs)).to.be.revertedWith(
                Exceptions.HARDCAP_OVERFLOW_REMAINING_SUPPLY
            );
        });
    });

    describe("Secondary TGE for preference token", async function () {
        let pToken: Token, pTGE: TGE;

        this.beforeEach(async function () {
            // Propose secondary TGE
            tgeArgs = await makeTGEArgs(createArgs[3], {
                tokenType: 2,
                name: "Preference DAO",
                symbol: "PDAO",
                cap: parseUnits("10000", 6),
                decimals: 6,
                description: "This is a preference token",
            });
            tgeArgs[0].minPurchase = parseUnits("10", 6);
            tgeArgs[0].maxPurchase = parseUnits("3000", 6);
            tgeArgs[0].hardcap = parseUnits("5000", 6);
            tgeArgs[0].softcap = parseUnits("1000", 6);
            tx = await pool.proposeTGE(...tgeArgs);

            await pool.connect(owner).castVote(1, true);
            await pool.connect(other).castVote(1, true);
            await mineBlock(2);
            await pool.executeProposal(1);

            const tgeRecord = await registry.contractRecords(3);
            pTGE = await getContractAt("TGE", tgeRecord.addr);
            pToken = await getContractAt("Token", await pTGE.token());
        });

        it("Can participate in TGE for preference", async function () {
            await pTGE.purchase(parseUnits("100", 6), {
                value: parseUnits("1"),
            });
            expect(await pToken.balanceOf(owner.address)).to.equal(
                parseUnits("50", 6)
            );
        });

        it("If bought less than softcap TGE is failed", async function () {
            await pTGE.purchase(parseUnits("100", 6), {
                value: parseUnits("1"),
            });
            await mineBlock(25);
            expect(await pTGE.state()).to.equal(1);
        });

        it("After preference initial TGE is successful, following TGE's can't update token data", async function () {
            // Success first TGE
            await pTGE.purchase(parseUnits("1000", 6), {
                value: parseUnits("10"),
            });
            await mineBlock(25);
            expect(await pTGE.state()).to.equal(2);

            // Start new TGE
            tgeArgs = await makeTGEArgs(createArgs[3], {
                tokenType: 2,
                name: "Preference DAO UPD",
                symbol: "PDAOUPD",
                cap: parseUnits("10000"),
                decimals: 10,
                description: "Another description",
            });
            tx = await pool.proposeTGE(...tgeArgs);
            await pool.connect(owner).castVote(2, true);
            await pool.connect(other).castVote(2, true);
            await mineBlock(2);
            await pool.executeProposal(2);

            // Check values
            expect(await pToken.name()).to.equal("Preference DAO");
            expect(await pToken.symbol()).to.equal("PDAO");
            expect(await pToken.decimals()).to.equal(6);
            expect(await pToken.description()).to.equal(
                "This is a preference token"
            );
        });
    });
});