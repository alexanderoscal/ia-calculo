require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { Groq } = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const SALT_ROUNDS = 10;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    db: { schema: 'public' }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());
app.use(express.static('public'));

// ------------------ REGISTRO ------------------
app.post('/api/registrar', async (req, res) => {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    try {
        const contrasenaEncriptada = await bcrypt.hash(contrasena, SALT_ROUNDS);
        const { error } = await supabase
            .from('usuarios_calculo')
            .insert([{ usuario: usuario.toLowerCase().trim(), contrasena: contrasenaEncriptada }]);
        if (error) {
            if (error.code === '23505') return res.status(400).json({ error: 'El usuario ya existe' });
            throw error;
        }
        res.json({ mensaje: 'Usuario creado con éxito' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al registrar usuario' });
    }
});

// ------------------ LOGIN ------------------
app.post('/api/login', async (req, res) => {
    const { usuario, contrasena } = req.body;
    if (!usuario || !contrasena) return res.status(400).json({ error: 'Campos incompletos' });
    try {
        const { data: user, error } = await supabase
            .from('usuarios_calculo')
            .select('*')
            .eq('usuario', usuario.toLowerCase().trim())
            .single();
        if (error || !user) return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
        const coincide = await bcrypt.compare(contrasena, user.contrasena);
        if (!coincide) return res.status(400).json({ error: 'Usuario o contraseña incorrectos' });
        res.json({ usuario: user.usuario });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error en el inicio de sesión' });
    }
});

// ------------------ FUNCIÓN PARA POST-PROCESAR LATEX ------------------
function asegurarDelimitadoresLaTeX(texto) {
    // Envuelve expresiones comunes de LaTeX que no estén ya dentro de $ o $$
    // Evita duplicar delimitadores
    if (!texto) return texto;
    // Patrón para encontrar \frac, \int, \sum, \lim, \sin, \cos, etc. sin delimitadores
    // Este es un reemplazo básico; lo ideal es confiar en las instrucciones de la IA.
    let nuevo = texto;
    // Evitar procesar dentro de bloques de código
    const bloquesCodigo = [];
    nuevo = nuevo.replace(/```[\s\S]*?```/g, (match) => {
        bloquesCodigo.push(match);
        return `__CODEBLOCK_${bloquesCodigo.length - 1}__`;
    });
    // Envolver expresiones sueltas que parecen LaTeX
    nuevo = nuevo.replace(/(?<!\$)(\\[a-zA-Z]+(?:\(.*?\))?(?:\^\{.*?\})?(?:\_.*?)?(?:\{.*?\})?)(?!\$)/g, '$$$1$$');
    // Restaurar bloques de código
    nuevo = nuevo.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => bloquesCodigo[parseInt(i)]);
    return nuevo;
}

// ------------------ ASISTENTE IA CON RAG ------------------
app.post('/api/preguntar', async (req, res) => {
    const { pregunta } = req.body;
    if (!pregunta) return res.status(400).json({ error: 'La pregunta es requerida' });

    try {
        // Tokenización para búsqueda semántica simple
        const palabras = pregunta.toLowerCase().match(/\b\w+\b/g) || [];
        const stopWords = ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'y', 'a', 'qué', 'cómo', 'cuál', 'por', 'para', 'con', 'sin', 'sobre', 'esa', 'este', 'esto', 'que', 'me', 'te', 'se', 'le', 'lo', 'la', 'las', 'los', 'mi', 'tu', 'su', 'del', 'al', 'como', 'más', 'pero', 'si', 'no', 'ya', 'muy', 'solo', 'tan', 'tanto', 'donde', 'cuando'];
        const tokensFiltrados = palabras.filter(t => !stopWords.includes(t) && t.length > 2);

        const { data: contenidos, error } = await supabase
            .from('contenido_calculo')
            .select('tema, contenido_texto, contexto_formateado, pasos_detallados, ejemplo_paso_paso, ejercicios_sugeridos, palabras_clave');
        if (error) throw error;

        let contextoEncontrado = "";
        let existeEnBD = false;

        if (contenidos && contenidos.length) {
            const filtrados = contenidos.filter(c => {
                if (pregunta.toLowerCase().includes(c.tema.toLowerCase())) return true;
                if (c.palabras_clave && Array.isArray(c.palabras_clave)) {
                    for (const token of tokensFiltrados) {
                        if (c.palabras_clave.some(pk => pk.toLowerCase().includes(token) || token.includes(pk.toLowerCase()))) {
                            return true;
                        }
                    }
                }
                const contenidoLower = c.contenido_texto.toLowerCase();
                if (tokensFiltrados.some(token => token.length > 3 && contenidoLower.includes(token))) return true;
                return false;
            });
            if (filtrados.length) {
                existeEnBD = true;
                contextoEncontrado = filtrados.slice(0, 3).map(c => {
                    let texto = `Tema: ${c.tema}\nExplicación: ${c.contenido_texto}\nFórmula: ${c.contexto_formateado || ''}`;
                    if (c.pasos_detallados && c.pasos_detallados.trim()) texto += `\n\n**Pasos detallados:**\n${c.pasos_detallados}`;
                    if (c.ejemplo_paso_paso && c.ejemplo_paso_paso.trim()) texto += `\n\n**Ejemplo paso a paso:**\n${c.ejemplo_paso_paso}`;
                    if (c.ejercicios_sugeridos && c.ejercicios_sugeridos.length) {
                        texto += `\n\n**Ejercicios sugeridos:**\n${c.ejercicios_sugeridos.map((e, i) => `${i + 1}. ${e}`).join('\n')}`;
                    }
                    return texto;
                }).join('\n\n---\n\n');
            }
        }

        let instruccionesIA = "";
        if (existeEnBD) {
            instruccionesIA = `Eres un tutor experto en Cálculo 1 para la UMG. Usa el siguiente contexto oficial de la base de datos universitaria para responder:\n\n${contextoEncontrado}\n\n**Reglas de formato OBLIGATORIAS:**\n- Usa **negritas** para conceptos clave.\n- Usa listas numeradas o viñetas.\n- **Todas las fórmulas matemáticas deben ir dentro de delimitadores LaTeX:**\n  * Fórmulas en línea: $ ... $  (ejemplo: $\\frac{dy}{dx} = 2x$)\n  * Fórmulas en bloque (destacadas): $$ ... $$  (ejemplo: $$\\int_a^b f(x)dx$$)\n- Nunca escribas expresiones LaTeX sin delimitadores.\n- Si la expresión es larga o contiene símbolos como \\frac, \\int, \\sum, \\lim, \\sin, etc., asegúrate de encerrarla en $$.\n- Incluye siempre un ejemplo resuelto paso a paso y al final ofrece 2 ejercicios similares para practicar.\n- Responde de manera didáctica, como si estuvieras explicando en pizarra.`;
        } else {
            instruccionesIA = `Eres un tutor experto en Cálculo 1 para la UMG.\n**IMPORTANTE**: El tema NO está en la base de datos local.\nTu respuesta DEBE comenzar con:\n\n**[Aviso: Esta respuesta fue generada usando el conocimiento general de la IA, ya que el tema específico no se encuentra mapeado en la base de datos de la universidad].**\n\nLuego salta una línea y responde normalmente. Aplica las mismas reglas de formato estrictas (negritas, listas, delimitadores LaTeX $ y $$, ejemplos y ejercicios).`;
        }

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: instruccionesIA },
                { role: "user", content: pregunta }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.5,
            max_tokens: 1500,
        });

        let respuestaIA = chatCompletion.choices[0]?.message?.content || "Lo siento, no pude generar una respuesta.";
        // Post-procesar para asegurar delimitadores (por si la IA falla)
        respuestaIA = asegurarDelimitadoresLaTeX(respuestaIA);
        res.json({ respuesta: respuestaIA });

    } catch (err) {
        console.error("Error en /api/preguntar:", err);
        let mensajeError = "❌ Error interno al procesar la consulta.";
        if (err.status === 429) {
            mensajeError = "🚫 Has alcanzado el límite gratuito de Groq por minuto. Espera unos segundos y vuelve a intentarlo.";
        } else if (err.message?.includes("API key")) {
            mensajeError = "🔑 Clave de API de Groq inválida o no configurada.";
        } else {
            mensajeError = `⚠️ Error: ${err.message || err}`;
        }
        res.status(500).json({ error: mensajeError });
    }
});

// ------------------ ENDPOINT: SUGERIR EJERCICIOS ------------------
app.post('/api/sugerir-ejercicios', async (req, res) => {
    const { tema } = req.body;
    if (!tema) return res.status(400).json({ error: 'Tema requerido' });

    try {
        const { data: contenidos, error } = await supabase
            .from('contenido_calculo')
            .select('ejercicios_sugeridos')
            .ilike('tema', `%${tema}%`);

        let ejercicios = [];
        if (contenidos && contenidos.length) {
            contenidos.forEach(c => {
                if (c.ejercicios_sugeridos && c.ejercicios_sugeridos.length)
                    ejercicios.push(...c.ejercicios_sugeridos);
            });
        }
        if (ejercicios.length >= 2) {
            return res.json({ ejercicios: ejercicios.slice(0, 5) });
        }

        const prompt = `Genera 3 ejercicios de cálculo sobre el tema "${tema}". Los ejercicios deben ser de dificultad variada y similares a los que aparecen en exámenes universitarios. Devuélvelos como un array de strings en formato JSON. Ejemplo: ["Ejercicio 1: ...", "Ejercicio 2: ...", "Ejercicio 3: ..."]`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "Eres un generador de ejercicios de cálculo. Responde solo con el array JSON, sin texto adicional." },
                { role: "user", content: prompt }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 0.7,
            max_tokens: 500,
        });

        let generados = [];
        const textoRespuesta = chatCompletion.choices[0]?.message?.content || "[]";
        const jsonMatch = textoRespuesta.match(/\[[\s\S]*\]/);
        if (jsonMatch) generados = JSON.parse(jsonMatch[0]);

        res.json({ ejercicios: generados });
    } catch (err) {
        console.error("Error en /api/sugerir-ejercicios:", err);
        res.status(500).json({ error: "No se pudieron generar ejercicios." });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor corriendo en puerto ${PORT} con RAG mejorado y post-procesado LaTeX`);
});