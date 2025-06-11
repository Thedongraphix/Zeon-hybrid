// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract CrowdFund {
    address public beneficiary;
    uint256 public goal;
    uint256 public deadline;
    uint256 public totalRaised;
    mapping(address => uint256) public contributions;
    address[] public contributors;

    enum State { Ongoing, Succeeded, Failed }

    event Contribution(address indexed contributor, uint256 amount);
    event Payout(address indexed beneficiary, uint256 amount);
    event Refund(address indexed contributor, uint256 amount);

    constructor(address _beneficiary, uint256 _goal, uint256 _duration) {
        beneficiary = _beneficiary;
        goal = _goal;
        deadline = block.timestamp + _duration;
    }

    function contribute() public payable {
        require(msg.value > 0, "Contribution must be greater than 0");
        require(block.timestamp < deadline, "Fundraiser has ended");

        if (contributions[msg.sender] == 0) {
            contributors.push(msg.sender);
        }
        
        contributions[msg.sender] += msg.value;
        totalRaised += msg.value;

        emit Contribution(msg.sender, msg.value);
    }

    function getBalance() public view returns (uint256) {
        return address(this).balance;
    }

    function isFundraiserActive() public view returns (bool) {
        return block.timestamp < deadline;
    }
    
    function getContributors() public view returns (address[] memory) {
        return contributors;
    }

    function getFundraiserState() public view returns (State) {
        if (block.timestamp < deadline) {
            return State.Ongoing;
        }
        if (totalRaised >= goal) {
            return State.Succeeded;
        }
        return State.Failed;
    }

    function payout() public {
        require(getFundraiserState() == State.Succeeded, "Fundraiser did not succeed");
        
        uint256 amount = address(this).balance;
        (bool sent, ) = beneficiary.call{value: amount}("");
        require(sent, "Failed to send funds");

        emit Payout(beneficiary, amount);
    }

    function refund() public {
        require(getFundraiserState() == State.Failed, "Fundraiser did not fail");
        
        uint256 amount = contributions[msg.sender];
        require(amount > 0, "No contribution to refund");
        
        contributions[msg.sender] = 0;
        (bool sent, ) = msg.sender.call{value: amount}("");
        require(sent, "Failed to send funds");

        emit Refund(msg.sender, amount);
    }

    // Fallback function to accept direct transfers
    receive() external payable {
        contribute();
    }
} 