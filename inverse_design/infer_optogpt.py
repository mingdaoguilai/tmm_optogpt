from pathlib import Path
import sys

import numpy as np
import torch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
OPTOGPT_ROOT = PROJECT_ROOT / "third_party" / "optogpt" / "optogpt"
MODEL_PATH = PROJECT_ROOT / "models" / "optogpt" / "optogpt.pt"
TARGET_PATH = PROJECT_ROOT / "targets" / "target.csv"

sys.path.insert(0, str(OPTOGPT_ROOT))

# 必须在torch.load之前导入官方模块
from core.datasets.datasets import subsequent_mask
from core.models.transformer import make_model_I
from core.trains.train import NoamOpt  # checkpoint反序列化需要


class OptoGPTDesigner:
    def __init__(self, model_path):
        self.device = torch.device(
            "cuda" if torch.cuda.is_available() else "cpu"
        )

        checkpoint = torch.load(
            model_path,
            map_location=self.device,
        )

        self.config = checkpoint["configs"]

        self.model = make_model_I(
            self.config.spec_dim,
            self.config.struc_dim,
            self.config.layers,
            self.config.d_model,
            self.config.d_ff,
            self.config.head_num,
            self.config.dropout,
        ).to(self.device)

        self.model.load_state_dict(
            checkpoint["model_state_dict"]
        )
        self.model.eval()

        self.word_to_id = self.config.struc_word_dict
        self.id_to_word = self.config.struc_index_dict

    @torch.inference_mode()
    def sample(
        self,
        spectrum_target,
        top_k=50,
        temperature=1.0,
        max_layers=20,
    ):
        spectrum_target = np.asarray(
            spectrum_target,
            dtype=np.float32,
        )

        expected_dimension = int(self.config.spec_dim)

        if spectrum_target.shape != (expected_dimension,):
            raise ValueError(
                f"模型要求输入维度为 {expected_dimension}，"
                f"实际维度为 {spectrum_target.shape}"
            )

        if not np.all(np.isfinite(spectrum_target)):
            raise ValueError("目标光谱中存在NaN或无穷值")

        if np.any(spectrum_target < 0) or np.any(
            spectrum_target > 1
        ):
            raise ValueError("反射率和透射率必须在0到1之间")

        # 与官方notebook一致，输入形状为[1, 1, 142]
        source = torch.as_tensor(
            spectrum_target,
            dtype=torch.float32,
            device=self.device,
        ).view(1, 1, -1)

        bos_id = self.word_to_id["BOS"]
        eos_id = self.word_to_id["EOS"]

        generated = torch.tensor(
            [[bos_id]],
            dtype=torch.long,
            device=self.device,
        )

        structure = []

        for _ in range(max_layers):
            target_mask = subsequent_mask(
                generated.size(1)
            ).to(self.device)

            output = self.model(
                source,
                generated,
                None,
                target_mask,
            )

            log_probabilities = self.model.generator(
                output[:, -1]
            ).squeeze(0)

            log_probabilities = (
                log_probabilities / temperature
            )

            # 禁止生成不应出现在结构中的特殊token
            for special_token in ("BOS", "PAD", "UNK"):
                token_id = self.word_to_id.get(
                    special_token
                )
                if token_id is not None:
                    log_probabilities[token_id] = -torch.inf

            probabilities = torch.softmax(
                log_probabilities,
                dim=-1,
            )

            # 只保留概率最高的top-k个token
            if 0 < top_k < probabilities.numel():
                top_indices = torch.topk(
                    probabilities,
                    top_k,
                ).indices

                filtered = torch.zeros_like(
                    probabilities
                )
                filtered[top_indices] = probabilities[
                    top_indices
                ]
                probabilities = filtered

            probabilities = (
                probabilities / probabilities.sum()
            )

            next_id = torch.multinomial(
                probabilities,
                num_samples=1,
            ).item()

            if next_id == eos_id:
                break

            token = self.id_to_word[next_id]
            structure.append(token)

            next_tensor = torch.tensor(
                [[next_id]],
                dtype=torch.long,
                device=self.device,
            )

            generated = torch.cat(
                [generated, next_tensor],
                dim=1,
            )

        return structure

    def generate_many(
        self,
        spectrum_target,
        candidate_count=20,
    ):
        candidates = []
        seen = set()

        # 允许多采样，以过滤重复结果
        for _ in range(candidate_count * 10):
            structure = self.sample(
                spectrum_target,
                top_k=50,
                temperature=1.0,
            )

            structure_key = tuple(structure)

            if structure and structure_key not in seen:
                seen.add(structure_key)
                candidates.append(structure)

            if len(candidates) >= candidate_count:
                break

        return candidates


def load_target_csv(path):
    data = np.loadtxt(
        path,
        delimiter=",",
        skiprows=1,
    )

    if data.shape != (71, 3):
        raise ValueError(
            "target.csv必须包含71行数据和3列："
            "wavelength_nm、R、T"
        )

    expected_wavelengths = np.arange(
        400,
        1101,
        10,
    )

    if not np.allclose(
        data[:, 0],
        expected_wavelengths,
    ):
        raise ValueError(
            "波长必须从400到1100 nm，间隔10 nm"
        )

    reflection = data[:, 1]
    transmission = data[:, 2]

    # OptoGPT要求先放71个R，再放71个T
    return np.concatenate(
        [reflection, transmission]
    )


def main():
    target = load_target_csv(TARGET_PATH)

    designer = OptoGPTDesigner(MODEL_PATH)

    candidates = designer.generate_many(
        target,
        candidate_count=20,
    )

    print(f"运行设备：{designer.device}")
    print(f"候选数量：{len(candidates)}")

    for index, structure in enumerate(
        candidates,
        start=1,
    ):
        print(f"\n候选 {index}")
        print(" / ".join(structure))


if __name__ == "__main__":
    main()
