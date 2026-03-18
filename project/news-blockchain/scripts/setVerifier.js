import { ethers } from "ethers";

const CONTRACT_ADDRESS  = "0xA4966bcDB8E2a86D8AFA634BFE87ffB4008d4184";
const VERIFIER_ADDRESS  = "0x256C516f50821B5e1E1AAe16dD936F232f625999";

const ABI = [
  "function setVerifier(address,bool) external",
  "function isVerifier(address) external view returns (bool)",
];

const provider = new ethers.JsonRpcProvider(
  `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`
);
const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

console.log("Owner wallet:", signer.address);
console.log("Setting verifier:", VERIFIER_ADDRESS);

const tx = await contract.setVerifier(VERIFIER_ADDRESS, true);
console.log("TX sent:", tx.hash);
await tx.wait();
console.log("✅ TX confirmed");

const result = await contract.isVerifier(VERIFIER_ADDRESS);
console.log("isVerifier:", result);