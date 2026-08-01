# RefMind3D 

A high-performance, unlimited reference canvas for designers and 3D creators, designed to unify and organize images, videos, documents, 3D models, mind maps, and creative inspiration.
面向设计师与 3D 创作者的高性能无限参考画布，用于统一整理图片、视频、文档、3D 模型、思维导图与创作灵感。

## Windows 一键运行（One-click run）

To run the development version for the first time: double-click `run-dev.bat`.

To package the release exe: double-click `build-release.bat`.

第一次运行开发版：双击 `run-dev.bat`。

打包 release exe：双击 `build-release.bat`。


## 使用（Use）

```powershell
npm install
npm run tauri:dev
```

打包（pack）：

```powershell
npm run tauri:build
```

## 说明（Explanation）

The production files of DDS vary greatly, especially those with BCn compression and DX10 headers. The current version will prioritize real decoding; if there is no available decoder on the local machine and the built-in decoding fails, a placeholder preview will be generated, but the original DDS file will be retained in the project resource directory.
DDS 的生产文件差异很大，尤其是 BCn 压缩和 DX10 头的 DDS。当前版本会优先尝试真实解码；如果本机没有可用解码器且内置解码失败，会生成占位预览，但原始 DDS 文件会保留在工程资源目录中。



## AI 接口介绍与使用规则（Introduction and Usage Rules of AI Interface）

RefMind3D configures "content analysis" and "image generation" as two separate interfaces, which can connect to local Ollama, OpenAI compatible services, Doubao, or custom HTTP services. The AI can read the currently selected text, images, and node information, and write the analysis results back to the canvas. After the image generation is successful, the new image will be directly inserted into the current canvas and automatically establish a connection line with the reference image.
RefMind3D 将“内容分析”和“图片生成”作为两套独立接口配置，既可以连接本地 Ollama，也可以连接 OpenAI 兼容服务、豆包或自定义 HTTP 服务。AI 可以读取当前选中的文本、图片及节点信息，将分析结果写回画布；图片生成成功后，新图会直接插入当前画布，并可与参考图自动建立牵引线。

### 接口配置（interface configuration）

- Right-click in the canvas to open "Settings → AI Interface", and configure the analysis model and image generation model separately.
- The analysis model is used for text response, content organization, and image understanding.
- The image generation model is used for text-to-image and reference image generation, and it must use a provider that truly supports image generation; the visual understanding model cannot replace the image generation model.
- The API address should be filled in with the basic address provided by the service provider. OpenAI compatible services usually end with `/v1`.
- The model name must be completely consistent with the actual model existing on the server.
After configuration, first use "Test Connection" to confirm the validity of the address, key, and model before starting the official call.
- 在画布中右键打开“设置 → AI 接口”，分别配置分析模型和图片生成模型。
- 分析模型用于文字回复、内容整理和图片理解。
- 图片生成模型用于文生图和参考图生成，必须使用真正支持图片生成的 Provider；视觉理解模型不能代替出图模型。
- API 地址应填写服务商提供的基础地址。OpenAI 兼容服务通常以 `/v1` 结尾。
- 模型名称必须与服务端实际存在的模型完全一致。
- 配置完成后，先使用“测试连接”确认地址、密钥和模型有效，再开始正式调用。

### 使用方法（Usage）

1. Select the text, images, or other nodes that need to be analyzed on the canvas; a visual analysis can attach up to 4 images at a time.
2. Open the AI panel on the left and enter your requirements. Press Enter to send, and use Shift+Enter for line breaks.
3. Click "Send Analysis" to perform text or visual analysis; click "Generate Image to Canvas" to call the image generation interface.
4. The analysis results can be written back as text or mind map nodes; the generated images will be inserted into the current canvas and automatically positioned.
1. 在画布中选择需要分析的文本、图片或其他节点；视觉分析单次最多附加 4 张图片。
2. 打开左侧 AI 面板，输入要求。按 Enter 发送，使用 Shift+Enter 换行。
3. 点击“发送分析”进行文字或视觉分析；点击“生成图片到画布”调用图片生成接口。
4. 分析结果可以写回为文本或思维导图节点；生成的图片会插入当前画布，并自动定位。

### 使用规则与安全说明（Usage rules and safety instructions）

- Please comply with the content policies, licensing terms, billing rules, and rate limits of the model service provider you are using.
- When sending analysis, the text, metadata, and selected images of the selected nodes may be uploaded to the configured service provider; please confirm the data and privacy policies of the service provider before processing sensitive information.
- The local Ollama is suitable for offline analysis, but only models that have been installed and possess visual capabilities can view images; it does not undertake image generation tasks by default.
- If the interface returns a message indicating that the model does not exist, the context exceeds the limit, or the format is incompatible, please first verify the model name, interface type, base address, and server capabilities.
- AI output is solely intended as a creative aid. Prior to publishing or commercial use, please manually verify the accuracy, copyright, and usability of the content.
- 请遵守所使用模型服务商的内容政策、授权条款、计费规则和速率限制。
- 发送分析时，选中节点的文字、元信息及所选图片可能会上传到配置的服务商；处理敏感资料前请确认服务商的数据与隐私政策。
- 本地 Ollama 适合离线分析，但只有已安装且具备视觉能力的模型才能看图；它默认不承担图片生成任务。
- 如果接口返回模型不存在、上下文超限或格式不兼容，请先核对模型名称、接口类型、基础地址及服务端能力。
- AI 输出仅作为创作辅助。发布或商用前，请人工检查内容准确性、版权和可用性。
