import { artifacts } from 'hardhat';
import { decodeEventLog } from 'viem';

type EventType = Awaited<ReturnType<typeof decodeEventLog>>;

export const getEventsFromTx = async (contractName: string, rec: TransactionReceipt): Promise<EventType[]> => {
  const factoryArtifact = await artifacts.readArtifact(contractName);

  if (!rec.logs) return [];
  const events = rec.logs
    .map((log) => {
      try {
        const event = decodeEventLog({
          abi: factoryArtifact.abi,
          data: log.data,
          topics: log.topics,
          strict: false,
        });
        return event;
      } catch (e) {
        return undefined;
      }
    })
    .filter((e) => e !== undefined);

  return events as unknown as EventType[];
};

export const walletAddress = async () => {
  const [signer] = await hre.viem.getWalletClients();
  return signer.account.address;
};
