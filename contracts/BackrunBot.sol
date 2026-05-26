// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IFlashLoanReceiver} from "@aave/core-v3/contracts/flashloan/interfaces/IFlashLoanReceiver.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BackrunBot
 * @dev Smart contract for executing backrun arbitrage using Aave flashloans
 * 
 * FLOW:
 * 1. Detect profitable MEV-Share order
 * 2. Request flashloan from Aave pool
 * 3. Execute swap/arbitrage in executeOperation()
 * 4. Repay flashloan + fee
 * 5. Withdraw profit
 */

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        bytes32 poolKey;
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract BackrunBot is IFlashLoanReceiver, Ownable {
    using SafeERC20 for IERC20;

    IPool public aavePool;
    address public WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    
    // Routers for swaps
    IUniswapV2Router public constant UNISWAP_V2_ROUTER = 
        IUniswapV2Router(0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D);
    
    address public constant AAVE_POOL_ADDRESS = 
        0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9;

    // Events
    event BackrunExecuted(
        address indexed token,
        uint256 flashloanAmount,
        uint256 profit,
        bool success
    );
    
    event FlashloanReceived(
        address indexed token,
        uint256 amount,
        uint256 fee
    );

    // Swap configuration
    struct SwapConfig {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOutMin;
        address[] path;
        uint256 deadline;
    }

    SwapConfig public currentSwapConfig;
    bool public isExecuting = false;

    constructor() {
        aavePool = IPool(AAVE_POOL_ADDRESS);
    }

    /**
     * @dev Initiates a flashloan and configures the swap
     * @param flashloanToken Token to flashloan
     * @param amount Amount to flashloan
     * @param swapConfig Configuration for the arbitrage swap
     */
    function initiateBackrun(
        address flashloanToken,
        uint256 amount,
        SwapConfig calldata swapConfig
    ) external onlyOwner {
        require(!isExecuting, "Backrun already in progress");
        require(amount > 0, "Amount must be greater than 0");

        // Store swap configuration for executeOperation
        currentSwapConfig = swapConfig;
        isExecuting = true;

        // Create array of tokens and amounts for flashloan
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = flashloanToken;
        amounts[0] = amount;

        // Create modes array (0 = no debt)
        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        // Initiate flashloan
        aavePool.flashLoan(
            address(this),
            tokens,
            amounts,
            modes,
            address(this),
            abi.encode(flashloanToken, amount),
            0
        );
    }

    /**
     * @dev Callback function called by Aave after flashloan
     * This is where the actual arbitrage happens
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bytes32) {
        require(msg.sender == address(aavePool), "Invalid flashloan source");
        require(initiator == address(this), "Invalid initiator");

        // Decode parameters
        (address flashloanToken, uint256 flashloanAmount) = abi.decode(
            params,
            (address, uint256)
        );

        // Calculate fee
        uint256 amountOwed = amount + premium;

        emit FlashloanReceived(asset, amount, premium);

        // ========== ARBITRAGE LOGIC ==========
        // 1. Approve token for swap
        IERC20(flashloanToken).safeApprove(address(UNISWAP_V2_ROUTER), amount);

        // 2. Execute swap
        uint256 amountOut = _executeSwap(amount);

        // 3. Verify we have enough to repay flashloan
        require(
            IERC20(flashloanToken).balanceOf(address(this)) >= amountOwed,
            "Insufficient balance to repay flashloan"
        );

        // 4. Approve Aave pool to take repayment
        IERC20(flashloanToken).safeApprove(address(aavePool), amountOwed);

        // ========== PROFIT CALCULATION ==========
        uint256 profit = IERC20(flashloanToken).balanceOf(address(this)) - amountOwed;

        emit BackrunExecuted(flashloanToken, flashloanAmount, profit, profit > 0);

        isExecuting = false;

        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }

    /**
     * @dev Internal function to execute swap
     * Can be extended to support multiple DEX routers
     */
    function _executeSwap(uint256 amountIn) internal returns (uint256) {
        SwapConfig memory config = currentSwapConfig;

        // Approve router
        IERC20(config.tokenIn).safeApprove(address(UNISWAP_V2_ROUTER), amountIn);

        // Execute swap
        uint256[] memory amounts = UNISWAP_V2_ROUTER.swapExactTokensForTokens(
            amountIn,
            config.amountOutMin,
            config.path,
            address(this),
            config.deadline
        );

        return amounts[amounts.length - 1];
    }

    /**
     * @dev Withdraw accumulated profit
     * @param token Token to withdraw
     * @param amount Amount to withdraw
     */
    function withdrawProfit(address token, uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be greater than 0");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance >= amount, "Insufficient balance");

        IERC20(token).safeTransfer(owner(), amount);
    }

    /**
     * @dev Withdraw all balance of a token
     * @param token Token to withdraw
     */
    function withdrawAll(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "No balance to withdraw");

        IERC20(token).safeTransfer(owner(), balance);
    }

    /**
     * @dev Receive ETH
     */
    receive() external payable {}

    /**
     * @dev Get contract balance
     */
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /**
     * @dev Aave pool address getter (required by interface)
     */
    function POOL() external view override returns (IPool) {
        return aavePool;
    }

    /**
     * @dev Update Aave pool address (if needed)
     */
    function setAavePool(address newPool) external onlyOwner {
        require(newPool != address(0), "Invalid address");
        aavePool = IPool(newPool);
    }

    /**
     * @dev Emergency function to cancel ongoing execution
     */
    function emergencyCancel() external onlyOwner {
        isExecuting = false;
    }
}
